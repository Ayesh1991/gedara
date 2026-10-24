// One matching run for one household (Phase 9b), in plain TypeScript so it is unit-tested with a fake
// fetch. The match-agent Edge Function gives it the bundle (rpc_match_bundle) and saves what it
// returns (rpc_match_save).
//
// Rules first (learned names, barcodes, trigram names, the inbox rules, memories, built-ins); the AI
// ladder (_shared/ai) only for what they can't settle; nothing is booked. An item whose input didn't
// change since its last suggestion is not asked again (cost, log budget). The bundle never carries an
// SMS body, and every text that goes to an AI passes the guard (labels instead of ids, codes stop the
// item).
import { billText, smsText, UnsafePrompt } from '../ai/guard.ts';
import { decide, type AskItem, type Budget, type Decision, type UsageRow } from '../ai/ladder.ts';
import type { CallResult, Fetch, ModelRef, Provider } from '../ai/providers.ts';
import type { AnswerOf } from '../ai/tasks.ts';
import { hash32 } from '../sms/parse.ts';
import { builtInCategory, payeeCategory } from './memory.ts';
import { billNameNorm } from './normalise.ts';
import { analyseInbox, namesNoShop, paymentEvidence, smsWhen, type AccountLite, type SmsRow, type TxCandidate } from './sms.ts';
import { buildMatcher, nameScore, trigrams, type AliasRow, type MatchProduct } from './spine.ts';

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  key: string | null;
  name: string;
  kind: string;
  default_destiny: string | null;
  archived: boolean;
}

export interface LineRow {
  id: string;
  fingerprint: string;
  raw_name: string;
  qty: number | null;
  unit_text: string | null;
  amount: number;
  category_id: string | null;
  destiny: string | null;
  shop: string | null;
  occurred_on: string;
  product_id?: string | null;
}

export interface ThingRow {
  id: string;
  raw_name: string;
  amount: number;
  category_id: string | null;
  shop: string | null;
  occurred_on: string;
}

/** How an alert of the last 120 days was booked (rpc_match_bundle, 9b.1). */
export interface BookedRow {
  sms_id: string;
  transaction_id: string;
  type: string;
  account_id: string;
  to_account_id: string | null;
  total: number;
  source: string;
  lines: number;
  line_id: string | null;
  category_id: string | null;
  has_fee: boolean;
}

export interface Settings {
  ai_enabled: boolean;
  steps?: ModelRef[];
  monthly_cap_usd?: number;
  daily_requests?: number;
}

export interface Bundle {
  settings: Settings;
  usage: { month_cost_usd: number; today: Partial<Record<Provider, number>> };
  accounts: AccountLite[];
  categories: CategoryRow[];
  products: MatchProduct[];
  aliases: AliasRow[];
  held: string[];
  merchant_memory: Array<{ merchant_norm: string; category_id: string | null; account_id: string | null }>;
  line_memory: Array<{ name_norm: string; category_id: string }>;
  suggestions: Array<{ task: string; target_key: string; input_hash: string; status: string }>;
  payee_category?: Array<{ payee_norm: string; category_id: string }>;
  // run
  booked?: BookedRow[];
  sms?: SmsRow[];
  candidates?: TxCandidate[];
  linked?: string[];
  lines?: LineRow[];
  other_lines?: LineRow[];
  things?: ThingRow[];
  // eval
  eval_lines?: LineRow[];
  eval_sms?: Array<{ id: string; merchant_text: string; amount: number; kind: string; category_id: string | null }>;
  evaluated?: string[];
}

export interface SuggestionOut {
  task: 'line_product' | 'line_category' | 'line_thing' | 'sms_category' | 'sms_link' | 'sms_rebook' | 'sms_recategorise';
  target_key: string;
  line_id?: string;
  sms_id?: string;
  proposal: Record<string, unknown>;
  confidence: number;
  pattern: string;
  models: string[];
  input_hash: string;
}

export interface EvalOut {
  task: 'line_product' | 'sms_category';
  target_key: string;
  truth: Record<string, unknown>;
  rule: Record<string, unknown> | null;
  ai: Record<string, unknown> | null;
  rule_correct: boolean | null;
  ai_correct: boolean | null;
}

export interface RunOutput {
  suggestions: SuggestionOut[];
  usage: UsageRow[];
  evals: EvalOut[];
  stale: Array<{ task: string; target_key: string }>;
  stats: Record<string, number | boolean>;
}

export interface RunEnv {
  keys: Partial<Record<Provider, string>>;
  fetchImpl?: Fetch;
}

/** Below this nothing is suggested: it would only be noise in the list. */
const SUGGEST_AT = 0.5;
/** Items per run (each run must finish well inside the function's time limit). */
const MAX = { lines: 48, other: 36, sms: 40, link: 20, things: 20, eval: 24 };
/** Your past choices count only when this many agree (and none disagrees); they are never "sure". */
const HISTORY_AT = 3;
const HISTORY_CONFIDENCE = 0.7;
const EVIDENCE_CONFIDENCE = 0.98;
const AUDIT_CONFIDENCE = 0.95;
/** A transfer debit and the card payment it paid: at most this far apart, and Rs 0–50 fee. */
const PAIR_WINDOW = 48 * 60 * 60 * 1000;
const PAIR_FEE = 50;
const DEFAULT_STEPS: ModelRef[] = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'openai', model: 'gpt-6-luna' },
  { provider: 'gemini', model: 'gemini-3.8-flash' },
];

// ── Labels: nothing real leaves Gedara, only P1 / C3 / T2 ─────────────────────
interface Labels {
  list: Array<{ id: string; name: string }>;
  toId: Map<string, string>;
  toLabel: Map<string, string>;
}

function labels(prefix: string, rows: Array<{ id: string; name: string }>): Labels {
  const list: Labels['list'] = [];
  const toId = new Map<string, string>();
  const toLabel = new Map<string, string>();
  for (const r of rows) {
    let name: string;
    try {
      name = billText(r.name, 60);
    } catch {
      continue; // a name that looks unsafe is simply not offered
    }
    const label = `${prefix}${list.length + 1}`;
    list.push({ id: label, name });
    toId.set(label, r.id);
    toLabel.set(r.id, label);
  }
  return { list, toId, toLabel };
}

/** Expense categories as "Top › Sub" (leaves only; a top without subs stands for itself). */
function categoryLabels(categories: CategoryRow[]): Labels {
  const live = categories.filter((c) => !c.archived && c.kind !== 'income');
  const tops = live.filter((c) => c.parent_id === null);
  const rows: Array<{ id: string; name: string }> = [];
  for (const t of tops) {
    const subs = live.filter((c) => c.parent_id === t.id);
    if (!subs.length) rows.push({ id: t.id, name: t.name });
    for (const s of subs) rows.push({ id: s.id, name: `${t.name} › ${s.name}` });
  }
  return labels('C', rows);
}

/** The predicted category is the known one, or a sub-category of it (a person may have picked a top). */
const categoryMatches = (categories: CategoryRow[], predicted: string | null, truth: string | null) =>
  !!predicted && !!truth && (predicted === truth || categories.find((c) => c.id === predicted)?.parent_id === truth);
/** The main category (Services for Services › Internet). */
const topOf = (categories: CategoryRow[], id: string | null) => {
  const c = id ? categories.find((x) => x.id === id) : undefined;
  return c ? c.parent_id ?? c.id : null;
};
const sameMain = (categories: CategoryRow[], a: string | null, b: string | null) => !!a && topOf(categories, a) === topOf(categories, b);
/** The same category, or a main category and one of its own subs. */
const agrees = (categories: CategoryRow[], a: string | null, b: string | null) =>
  categoryMatches(categories, a, b) || categoryMatches(categories, b, a);

// ── Budget: the owner's monthly cap and daily request cap ──────────────────────
export function makeBudget(bundle: Bundle): Budget & { calls: number; spent: number } {
  const cap = Number(bundle.settings.monthly_cap_usd ?? 0.9);
  const daily = Number(bundle.settings.daily_requests ?? 150);
  const today = { ...bundle.usage.today };
  const b = {
    calls: 0,
    spent: 0,
    allow(ref: ModelRef) {
      if (!bundle.settings.ai_enabled) return false;
      if (Number(bundle.usage.month_cost_usd) + b.spent >= cap) return false;
      return (today[ref.provider] ?? 0) < daily;
    },
    spend(ref: ModelRef, r: CallResult) {
      b.calls += 1;
      b.spent += r.costUsd;
      today[ref.provider] = (today[ref.provider] ?? 0) + 1;
    },
  };
  return b;
}

const hashOf = (x: unknown) => `h${hash32(JSON.stringify(x))}`;

// ── Bill lines → product / not pantry / category ──────────────────────────────
interface LineCtx {
  cats: Labels;
  prods: Labels;
  matcher: ReturnType<typeof buildMatcher>;
  productTrigrams: Array<{ id: string; names: Set<string>[] }>;
  topKeyOf: (categoryId: string | null) => string | null;
}

function lineContext(bundle: Bundle, withAliases: boolean): LineCtx {
  const active = bundle.products.filter((p) => !p.archived);
  const byId = new Map(bundle.categories.map((c) => [c.id, c]));
  const topKeyOf = (id: string | null) => {
    const c = id ? byId.get(id) : undefined;
    const top = c?.parent_id ? byId.get(c.parent_id) : c;
    return top?.id ?? null;
  };
  return {
    cats: categoryLabels(bundle.categories),
    prods: labels('P', active.slice(0, 400)),
    matcher: buildMatcher({
      products: bundle.products,
      aliases: withAliases ? bundle.aliases : [],
      barcodes: [],
      topOf: topKeyOf,
      heldProductIds: new Set(bundle.held),
    }),
    productTrigrams: active.map((p) => ({ id: p.id, names: [trigrams(p.name), ...(p.name_si ? [trigrams(p.name_si)] : [])] })),
    topKeyOf,
  };
}

/** The line as an AI sees it, with up to 12 likely products as candidates. */
function linePayload(ctx: LineCtx, l: LineRow) {
  const line = trigrams(l.raw_name);
  const candidates = ctx.productTrigrams
    .map((p) => ({ id: p.id, score: nameScore(p.names, line) }))
    .filter((p) => p.score >= 0.15 && ctx.prods.toLabel.has(p.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((p) => ctx.prods.toLabel.get(p.id)!);
  return {
    name: billText(l.raw_name),
    qty: l.qty,
    unit: l.unit_text ? billText(l.unit_text, 12) : null,
    amount: Number(l.amount),
    shop: l.shop ? billText(l.shop, 60) : null,
    candidates,
  };
}

async function askLines(
  rows: LineRow[],
  ctx: LineCtx,
  env: RunEnv,
  budget: Budget,
  steps: ModelRef[],
  ruleFor: (l: LineRow) => AskItem<AnswerOf<'lines'>>['rule'],
) {
  const items: AskItem<AnswerOf<'lines'>>[] = [];
  const candidatesOf = new Map<number, Set<string>>();
  const blocked = new Set<number>();
  rows.forEach((l, i) => {
    try {
      const payload = linePayload(ctx, l);
      candidatesOf.set(i, new Set(payload.candidates));
      items.push({ i, payload, rule: ruleFor(l) });
    } catch (err) {
      if (!(err instanceof UnsafePrompt)) throw err;
      blocked.add(i);
    }
  });
  const usedProducts = new Set(items.flatMap((x) => [...(candidatesOf.get(x.i) ?? [])]));
  const { decisions, usage } = await decide({
    task: 'lines',
    items,
    shared: { categories: ctx.cats.list, products: ctx.prods.list.filter((p) => usedProducts.has(p.id)) },
    steps,
    keys: env.keys,
    budget,
    fetchImpl: env.fetchImpl,
    labelOk: (a) => ctx.cats.toId.has(a.category) && (a.product === null || !!candidatesOf.get(a.i)?.has(a.product)),
  });
  return { decisions, usage, blocked };
}

/** The rules' vote for a line: a learned name or a clear trigram match (product facet only). */
function lineRule(ctx: LineCtx, l: LineRow): AskItem<AnswerOf<'lines'>>['rule'] {
  const m = ctx.matcher.match({ raw_name: l.raw_name, categoryTop: ctx.topKeyOf(l.category_id) });
  const cat = (l.category_id && ctx.cats.toLabel.get(l.category_id)) || ctx.cats.list[0]?.id || 'C1';
  if (m.via === 'alias' && m.destiny && m.destiny !== 'stock') {
    return { answer: { i: 0, destiny: m.destiny, product: null, category: cat, confidence: 1 }, facets: [0] };
  }
  const label = m.productId ? ctx.prods.toLabel.get(m.productId) : undefined;
  if (label && (m.confidence === 'sure' || m.confidence === 'check')) {
    return { answer: { i: 0, destiny: 'stock', product: label, category: cat, confidence: m.confidence === 'sure' ? 1 : 0.7 }, facets: [0] };
  }
  return undefined;
}

// ── The run ───────────────────────────────────────────────────────────────────
export async function runMatching(bundle: Bundle, env: RunEnv): Promise<RunOutput> {
  const out: RunOutput = { suggestions: [], usage: [], evals: [], stale: [], stats: {} };
  const steps = bundle.settings.steps?.length ? bundle.settings.steps : DEFAULT_STEPS;
  const budget = makeBudget(bundle);
  const known = new Map(bundle.suggestions.map((s) => [`${s.task}:${s.target_key}`, s]));
  const unchanged = (task: string, key: string, hash: string) => {
    const s = known.get(`${task}:${key}`);
    return !!s && s.input_hash === hash && s.status !== 'stale';
  };
  const open = new Set<string>();
  const ctx = lineContext(bundle, true);
  const memLine = new Map(bundle.line_memory.map((m) => [m.name_norm, m.category_id]));
  const memMerchant = new Map(bundle.merchant_memory.map((m) => [m.merchant_norm, m]));

  // 1. Pantry lines still without a product
  const lines = (bundle.lines ?? []).filter((l) => {
    open.add(`line_product:${l.fingerprint}`);
    return true;
  });
  const lineHash = (l: LineRow) => hashOf([l.raw_name, l.amount, l.category_id, bundle.products.length, bundle.aliases.length, steps]);
  const ruleSure: LineRow[] = [];
  const toAsk: LineRow[] = [];
  for (const l of lines) {
    if (unchanged('line_product', l.fingerprint, lineHash(l))) continue;
    const m = ctx.matcher.match({ raw_name: l.raw_name, categoryTop: ctx.topKeyOf(l.category_id) });
    if (m.confidence === 'sure') ruleSure.push(l);
    else if (toAsk.length < MAX.lines) toAsk.push(l);
  }
  for (const l of ruleSure) {
    const m = ctx.matcher.match({ raw_name: l.raw_name, categoryTop: ctx.topKeyOf(l.category_id) });
    out.suggestions.push({
      task: 'line_product', target_key: l.fingerprint, line_id: l.id,
      proposal: { destiny: m.destiny ?? 'stock', product_id: m.productId },
      confidence: 0.99, pattern: 'rule', models: [], input_hash: lineHash(l),
    });
  }
  if (toAsk.length) {
    const { decisions, usage } = await askLines(toAsk, ctx, env, budget, steps, (l) => lineRule(ctx, l));
    out.usage.push(...usage);
    toAsk.forEach((l, i) => {
      const d = decisions.get(i);
      const a = d?.answer;
      if (!d || !a || d.confidence < SUGGEST_AT) return;
      if (a.destiny === 'stock' && !a.product) return; // a product that doesn't exist yet: the import asks
      if (a.destiny === 'asset') return; // Things lines are entered from "Bought, not entered yet"
      out.suggestions.push({
        task: 'line_product', target_key: l.fingerprint, line_id: l.id,
        proposal: { destiny: a.destiny, product_id: a.product ? ctx.prods.toId.get(a.product) ?? null : null },
        confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model), input_hash: lineHash(l),
      });
    });
  }

  // 2. Lines left in a catch-all "Other …" category
  const otherAsk: LineRow[] = [];
  const otherHash = (l: LineRow) => hashOf([l.raw_name, l.category_id, bundle.categories.length, steps]);
  for (const l of bundle.other_lines ?? []) {
    open.add(`line_category:${l.fingerprint}`);
    if (unchanged('line_category', l.fingerprint, otherHash(l))) continue;
    const taught = memLine.get(billNameNorm(l.raw_name));
    if (taught && taught !== l.category_id) {
      out.suggestions.push({
        task: 'line_category', target_key: l.fingerprint, line_id: l.id, proposal: { category_id: taught },
        confidence: 0.99, pattern: 'rule', models: [], input_hash: otherHash(l),
      });
    } else if (!taught && otherAsk.length < MAX.other) otherAsk.push(l);
  }
  if (otherAsk.length) {
    const { decisions, usage } = await askLines(otherAsk, ctx, env, budget, steps, () => undefined);
    out.usage.push(...usage);
    otherAsk.forEach((l, i) => {
      const d = decisions.get(i);
      const id = d?.answer ? ctx.cats.toId.get(d.answer.category) : undefined;
      if (!d || !id || id === l.category_id || d.confidence < SUGGEST_AT) return;
      out.suggestions.push({
        task: 'line_category', target_key: l.fingerprint, line_id: l.id, proposal: { category_id: id },
        confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model), input_hash: otherHash(l),
      });
    });
  }

  // 3. Bank alerts: the inbox rules, then the AI for a merchant's category or a fuzzy bill match
  const sms = bundle.sms ?? [];
  if (sms.length) {
    const analysis = analyseInbox(sms, bundle.candidates ?? [], new Set(bundle.linked ?? []), bundle.accounts);
    const fresh = sms.filter((s) => !s.ignored && !s.transaction_id);
    const cats = categoryLabels(bundle.categories);
    const catItems: AskItem<AnswerOf<'sms_category'>>[] = [];
    const catRows: SmsRow[] = [];
    const linkItems: AskItem<AnswerOf<'sms_link'>>[] = [];
    const linkRows: Array<{ s: SmsRow; byLabel: Map<string, string>; hash: string }> = [];
    const suspense = new Set(bundle.accounts.filter((a) => a.is_suspense).map((a) => a.id));
    const linkedNow = new Set(bundle.linked ?? []);
    const payees = new Map((bundle.payee_category ?? []).map((p) => [p.payee_norm, p.category_id]));
    const audit = checkPastBookings(bundle, sms, payees);
    for (const a of audit) {
      open.add(`${a.task}:${a.target_key}`);
      if (!unchanged(a.task, a.target_key, a.input_hash)) out.suggestions.push(a);
    }
    const contradicted = new Set(audit.flatMap((a) => (a.proposal.delete_tx as string[] | undefined) ?? [String(a.proposal.transaction_id)]));
    for (const s of fresh) {
      // A suggestion stays open only while this run still stands by it; one whose reason is gone (evidence
      // that no longer pairs, a category now remembered, a bank text that names no shop) goes stale.
      const sug = analysis.suggestions.get(s.id);
      const amount = analysis.lkr.get(s.id)?.amount ?? s.amount;
      if (!sug || amount === null) continue;

      // its category: evidence (a payee's confirmation) → memories / built-ins → your past choices → the AI
      const evidenced = sug.kind === 'expense' && sug.evidence ? payeeCategory(bundle.categories, payees, sug.evidence) : null;
      if (sug.kind === 'expense' && evidenced) {
        open.add(`sms_category:${s.id}`);
        const hash = hashOf(['evidence', sug.evidence, evidenced]);
        if (!unchanged('sms_category', s.id, hash)) {
          out.suggestions.push({
            task: 'sms_category', target_key: s.id, sms_id: s.id, proposal: { category_id: evidenced, evidence: sug.evidence },
            confidence: EVIDENCE_CONFIDENCE, pattern: 'evidence', models: [], input_hash: hash,
          });
        }
      } else if (sug.kind === 'expense') {
        const memo = sug.memo ?? s.merchant_text;
        const noShop = !sug.evidence && namesNoShop(memo);
        // a bank's own wording ("CEFT Transfer Debit") names no shop: a single remembered choice is no evidence
        const remembered = noShop ? null : memMerchant.get(billNameNorm(memo))?.category_id ?? builtInCategory(bundle.categories, memo);
        const past = remembered ? null : pastChoice(bundle.booked ?? [], sms, s, amount, contradicted);
        const hash = hashOf([memo, Math.round(amount), cats.list.length, steps]);
        if (past) {
          open.add(`sms_category:${s.id}`);
          const h = hashOf(['history', past.category_id, past.count]);
          if (!unchanged('sms_category', s.id, h)) {
            out.suggestions.push({
              task: 'sms_category', target_key: s.id, sms_id: s.id, proposal: { category_id: past.category_id, past: past.count },
              confidence: HISTORY_CONFIDENCE, pattern: 'history', models: [], input_hash: h,
            });
          }
        } else if (!remembered && !noShop && memo) open.add(`sms_category:${s.id}`);
        if (!past && !remembered && !noShop && memo && !unchanged('sms_category', s.id, hash) && catItems.length < MAX.sms) {
          try {
            catItems.push({ i: catRows.length, payload: { merchant: smsText(memo), amount: Math.round(amount), kind: s.kind } });
            catRows.push(s);
            known.set(`sms_category:${s.id}`, { task: 'sms_category', target_key: s.id, input_hash: hash, status: 'asked' });
          } catch (err) {
            if (!(err instanceof UnsafePrompt)) throw err;
          }
        }
      }

      // no exact match: a bill whose total is close (service charge, tip, rounding)?
      if ((sug.kind === 'expense' || sug.kind === 'none') && s.kind === 'card_charge' && linkItems.length < MAX.link) {
        const close = (bundle.candidates ?? [])
          .filter((t) => t.type === 'expense' && !linkedNow.has(t.id))
          .filter((t) => t.account_id === s.account_id || suspense.has(t.account_id))
          .filter((t) => Math.abs(Date.parse(t.occurred_on) - Date.parse(s.occurred_on)) <= 3 * 86_400_000)
          .filter((t) => Math.round(t.total * 100) !== Math.round(amount * 100))
          .filter((t) => t.total >= amount * 0.85 && t.total <= amount * 1.15)
          .sort((a, b) => Math.abs(a.total - amount) - Math.abs(b.total - amount))
          .slice(0, 5);
        if (!close.length) continue;
        open.add(`sms_link:${s.id}`);
        const hash = hashOf([s.merchant_text, amount, close.map((t) => t.id), steps]);
        if (unchanged('sms_link', s.id, hash)) continue;
        try {
          const byLabel = new Map(close.map((t, k) => [`T${k + 1}`, t.id]));
          linkItems.push({
            i: linkRows.length,
            payload: {
              merchant: smsText(s.merchant_text), amount: Math.round(amount * 100) / 100, day: s.occurred_on,
              candidates: close.map((t, k) => ({ id: `T${k + 1}`, payee: billText(t.payee_text ?? '-', 60), total: Number(t.total), day: t.occurred_on })),
            },
          });
          linkRows.push({ s, byLabel, hash });
        } catch (err) {
          if (!(err instanceof UnsafePrompt)) throw err;
        }
      }
    }
    if (catItems.length) {
      const { decisions, usage } = await decide({
        task: 'sms_category', items: catItems, shared: { categories: cats.list }, steps, keys: env.keys, budget,
        fetchImpl: env.fetchImpl, labelOk: (a) => cats.toId.has(a.category),
      });
      out.usage.push(...usage);
      catRows.forEach((s, i) => {
        const d = decisions.get(i);
        const id = d?.answer ? cats.toId.get(d.answer.category) : undefined;
        if (!d || !id || d.confidence < SUGGEST_AT) return;
        out.suggestions.push({
          task: 'sms_category', target_key: s.id, sms_id: s.id, proposal: { category_id: id },
          confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model),
          input_hash: known.get(`sms_category:${s.id}`)!.input_hash,
        });
      });
    }
    if (linkItems.length) {
      const { decisions, usage } = await decide({
        task: 'sms_link', items: linkItems, shared: {}, steps, keys: env.keys, budget, fetchImpl: env.fetchImpl,
        labelOk: (a) => a.candidate === null || !!linkRows[a.i]?.byLabel.has(a.candidate),
      });
      out.usage.push(...usage);
      linkRows.forEach(({ s, byLabel, hash }, i) => {
        const d = decisions.get(i);
        const txId = d?.answer?.candidate ? byLabel.get(d.answer.candidate) : undefined;
        if (!d || !txId || d.confidence < SUGGEST_AT) return;
        out.suggestions.push({
          task: 'sms_link', target_key: s.id, sms_id: s.id, proposal: { transaction_id: txId },
          confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model), input_hash: hash,
        });
      });
    }
  }

  // 4. Things bought, not entered yet: a clear name, maker, model and category to start from
  const things = (bundle.things ?? []).slice(0, 200);
  const thingItems: AskItem<AnswerOf<'thing'>>[] = [];
  const thingRows: Array<{ t: ThingRow; hash: string }> = [];
  for (const t of things) {
    open.add(`line_thing:${t.id}`);
    const hash = hashOf([t.raw_name, t.category_id, steps]);
    if (unchanged('line_thing', t.id, hash) || thingItems.length >= MAX.things) continue;
    try {
      thingItems.push({ i: thingRows.length, payload: { name: billText(t.raw_name), amount: Number(t.amount), shop: t.shop ? billText(t.shop, 60) : null } });
      thingRows.push({ t, hash });
    } catch (err) {
      if (!(err instanceof UnsafePrompt)) throw err;
    }
  }
  if (thingItems.length) {
    const { decisions, usage } = await decide({
      task: 'thing', items: thingItems, shared: { categories: ctx.cats.list }, steps, keys: env.keys, budget,
      fetchImpl: env.fetchImpl, labelOk: (a) => ctx.cats.toId.has(a.category),
    });
    out.usage.push(...usage);
    thingRows.forEach(({ t, hash }, i) => {
      const d = decisions.get(i);
      const a = d?.answer;
      if (!d || !a || d.confidence < SUGGEST_AT) return;
      out.suggestions.push({
        task: 'line_thing', target_key: t.id, line_id: t.id,
        proposal: { name: a.name, maker: a.maker, model: a.model, category_id: ctx.cats.toId.get(a.category) ?? null },
        confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model), input_hash: hash,
      });
    });
  }

  // 5. Suggestions whose item was dealt with elsewhere (linked, routed, entered) go stale
  for (const s of bundle.suggestions) {
    if (s.status === 'pending' && !open.has(`${s.task}:${s.target_key}`)) out.stale.push({ task: s.task, target_key: s.target_key });
  }

  out.stats = {
    suggestions: out.suggestions.length,
    stale: out.stale.length,
    ai_calls: out.usage.length,
    ai_failed: out.usage.filter((u) => !u.ok).length,
    cost_usd: Math.round(out.usage.reduce((a, u) => a + u.cost_usd, 0) * 1e6) / 1e6,
    ai_enabled: !!bundle.settings.ai_enabled,
  };
  return out;
}

// ── Your past choices (a weak hint) ──────────────────────────────────────────
/**
 * What you booked before for the same alert wording and a similar amount (±5 %): only when at least
 * three entries agree and none disagrees, and never ones the evidence contradicts.
 */
export function pastChoice(
  booked: BookedRow[], sms: SmsRow[], s: SmsRow, amount: number, contradicted: ReadonlySet<string>,
): { category_id: string; count: number } | null {
  const key = billNameNorm(s.merchant_text);
  if (!key) return null;
  const byId = new Map(sms.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const votes = new Map<string, number>();
  for (const b of booked) {
    if (b.type !== 'expense' || b.lines !== 1 || !b.category_id || b.sms_id === s.id) continue;
    if (seen.has(b.transaction_id) || contradicted.has(b.transaction_id)) continue;
    const m = byId.get(b.sms_id);
    if (!m || m.amount === null || billNameNorm(m.merchant_text) !== key) continue;
    if (Math.abs(m.amount - amount) > amount * 0.05) continue;
    seen.add(b.transaction_id);
    votes.set(b.category_id, (votes.get(b.category_id) ?? 0) + 1);
  }
  if (votes.size !== 1) return null;
  const [category_id, count] = [...votes][0]!;
  return count >= HISTORY_AT ? { category_id, count } : null;
}

// ── "Check past bookings": evidence that disagrees with what was booked (9b.1) ──
/**
 *   sms_rebook — a transfer debit ("CEFT Transfer Debit Rs 25,025") booked as an expense while a card
 *     payment of Rs 25,000 (± up to Rs 50 fee) arrived within 48 h: it was a transfer to that card.
 *     The proposal is rpc_sms_rebook's parameter (join the card payment's transfer, or a new transfer).
 *   sms_recategorise — a booked expense whose payee's confirmation names another category
 *     (Dialog says Rs 198 was a reload; the line says Banking & fees).
 * Nothing changes until a person taps Fix.
 */
export function checkPastBookings(bundle: Bundle, sms: SmsRow[], payees: ReadonlyMap<string, string>): SuggestionOut[] {
  const booked = bundle.booked ?? [];
  if (!booked.length) return [];
  const out: SuggestionOut[] = [];
  const bySms = new Map(booked.map((b) => [b.sms_id, b]));
  const smsById = new Map(sms.map((m) => [m.id, m]));
  const cents = (n: number) => Math.round(n * 100);
  const services = bundle.categories.find((c) => c.parent_id === null && c.key === 'services');
  const feeCategory = bundle.categories.find((c) => c.parent_id === services?.id && c.name === 'Banking & fees')?.id ?? null;
  const done = new Set<string>();
  const usedPayments = new Set<string>();

  const debits = booked
    .filter((b) => b.type === 'expense' && b.source === 'sms' && b.lines <= 1)
    .map((b) => ({ b, d: smsById.get(b.sms_id) }))
    .filter((x): x is { b: BookedRow; d: SmsRow } =>
      !!x.d && x.d.kind === 'bank_debit' && x.d.amount !== null && !!x.d.account_id && namesNoShop(x.d.merchant_text));
  for (const { b, d } of debits) {
    if (done.has(b.transaction_id)) continue;
    const hit = sms
      .filter((p) => p.kind === 'card_payment' && p.amount !== null && !!p.account_id && p.account_id !== d.account_id && !usedPayments.has(p.id))
      .map((p) => ({ p, fee: cents(d.amount!) - cents(p.amount!), dt: Math.abs(smsWhen(p) - smsWhen(d)) }))
      .filter((x) => x.fee >= 0 && x.fee <= PAIR_FEE * 100 && x.dt <= PAIR_WINDOW)
      .sort((x, y) => x.dt - y.dt)[0];
    if (!hit) continue;
    const pb = hit.p.transaction_id ? bySms.get(hit.p.id) : undefined;
    if (hit.p.transaction_id && !pb) continue; // booked before the 120 days: leave it
    const deleteTx = [b.transaction_id];
    let transferId: string | null = null;
    if (pb?.type === 'transfer') {
      if (cents(pb.total) !== cents(hit.p.amount!)) continue;
      // the transfer already has its bank side: this debit was something else
      if (sms.some((m) => m.transaction_id === pb.transaction_id && m.kind === 'bank_debit')) continue;
      transferId = pb.transaction_id;
    } else if (pb) {
      if (pb.type !== 'expense' && pb.type !== 'income') continue;
      if (pb.source !== 'sms' || pb.lines > 1) continue;
      if (pb.transaction_id !== b.transaction_id) deleteTx.push(pb.transaction_id);
    }
    usedPayments.add(hit.p.id);
    deleteTx.forEach((t) => done.add(t));
    const proposal = {
      debit_sms: d.id,
      delete_tx: deleteTx,
      transfer_id: transferId,
      to_account_id: transferId ? null : hit.p.account_id,
      payment_sms: transferId ? null : hit.p.id,
      total: hit.p.amount!,
      fee: hit.fee / 100,
      fee_category_id: hit.fee > 0 ? feeCategory : null,
      // for the person deciding
      from_account_id: d.account_id,
      card_account_id: hit.p.account_id,
      was_category_id: b.category_id,
      transaction_id: b.transaction_id,
    };
    out.push({
      task: 'sms_rebook', target_key: d.id, sms_id: d.id, proposal,
      confidence: AUDIT_CONFIDENCE, pattern: 'evidence', models: [], input_hash: hashOf(['rebook', proposal]),
    });
  }

  const evidence = paymentEvidence(sms);
  for (const b of booked) {
    if (b.type !== 'expense' || b.lines !== 1 || !b.category_id || !b.line_id || done.has(b.transaction_id)) continue;
    const e = evidence.get(b.sms_id);
    const want = e ? payeeCategory(bundle.categories, payees, e.payee) : null;
    // a main category and one of its own subs agree (Grocery vs Grocery › Other grocery); siblings don't
    if (!e || !want || agrees(bundle.categories, want, b.category_id)) continue;
    done.add(b.transaction_id);
    const proposal = { line_id: b.line_id, transaction_id: b.transaction_id, category_id: want, was_category_id: b.category_id, payee: e.payee, receipt_sms: e.fromSmsId };
    out.push({
      task: 'sms_recategorise', target_key: b.sms_id, sms_id: b.sms_id, line_id: b.line_id, proposal,
      confidence: AUDIT_CONFIDENCE, pattern: 'evidence', models: [], input_hash: hashOf(['recategorise', proposal]),
    });
  }
  return out;
}

// ── The accuracy test: questions with a known answer ──────────────────────────
// Learned names are left out (they'd be right by construction): the test measures the trigram rules
// and the AI on lines and alerts a person already decided. It runs in batches; `remaining` says how
// many are left, and the page asks again until it is 0.
export async function runEval(bundle: Bundle, env: RunEnv): Promise<RunOutput & { remaining: number; total: number }> {
  const out: RunOutput = { suggestions: [], usage: [], evals: [], stale: [], stats: {} };
  const steps = bundle.settings.steps?.length ? bundle.settings.steps : DEFAULT_STEPS;
  const budget = makeBudget({ ...bundle, settings: { ...bundle.settings, ai_enabled: true } });
  const done = new Set(bundle.evaluated ?? []);
  const evalLines = (bundle.eval_lines ?? []).filter((l) => !done.has(`line_product:${l.fingerprint}`));
  const evalSms = (bundle.eval_sms ?? []).filter((s) => !done.has(`sms_category:${s.id}`));
  const total = (bundle.eval_lines?.length ?? 0) + (bundle.eval_sms?.length ?? 0);

  const lineBatch = evalLines.slice(0, MAX.eval);
  if (lineBatch.length) {
    const ctx = lineContext(bundle, false);
    const { decisions, usage, blocked } = await askLines(lineBatch, ctx, env, budget, steps, (l) => lineRule(ctx, l));
    out.usage.push(...usage);
    lineBatch.forEach((l, i) => {
      const truth = { destiny: l.destiny === 'asset' ? 'asset' : 'stock', product_id: l.destiny === 'asset' ? null : l.product_id ?? null };
      const m = ctx.matcher.match({ raw_name: l.raw_name, categoryTop: ctx.topKeyOf(l.category_id) });
      const ruleAnswered = m.productId !== null && m.confidence !== 'none';
      const d: Decision<AnswerOf<'lines'>> | undefined = decisions.get(i);
      const a = d?.answer;
      const aiProduct = a?.product ? ctx.prods.toId.get(a.product) ?? null : null;
      out.evals.push({
        task: 'line_product', target_key: l.fingerprint, truth,
        rule: ruleAnswered ? { product_id: m.productId, sure: m.confidence === 'check' } : null,
        ai: a && d ? { destiny: a.destiny, product_id: aiProduct, confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model) }
          : blocked.has(i) ? { blocked: true } : null,
        rule_correct: ruleAnswered ? truth.destiny === 'stock' && m.productId === truth.product_id : null,
        ai_correct: a && d && d.votes.length ? a.destiny === truth.destiny && (truth.destiny !== 'stock' || aiProduct === truth.product_id) : null,
      });
    });
  }

  const smsBatch = evalSms.slice(0, MAX.eval);
  if (smsBatch.length) {
    const cats = categoryLabels(bundle.categories);
    const items: AskItem<AnswerOf<'sms_category'>>[] = [];
    const rows: typeof smsBatch = [];
    // 9b.1: a payee's confirmation outranks what a person picked. Where it disagrees the choice is left
    // out of the score (it is in "Check past bookings"); where it agrees it is evidence-confirmed. An
    // alert that names no shop is never asked (the AI could only guess), only counted.
    const payees = new Map((bundle.payee_category ?? []).map((p) => [p.payee_norm, p.category_id]));
    const evidence = paymentEvidence(bundle.sms ?? []);
    const evidenced = new Map<string, string>();
    for (const s of smsBatch) {
      const e = evidence.get(s.id);
      const evCat = e ? payeeCategory(bundle.categories, payees, e.payee) : null;
      if (evCat && !agrees(bundle.categories, s.category_id, evCat)) {
        out.evals.push({ task: 'sms_category', target_key: s.id, truth: { category_id: evCat, chosen: s.category_id, contradicted: true, payee: e!.payee }, rule: null, ai: null, rule_correct: null, ai_correct: null });
        continue;
      }
      if (evCat) {
        evidenced.set(s.id, evCat);
        out.evals.push({
          task: 'sms_category', target_key: s.id, truth: { category_id: s.category_id, evidence: true, payee: e!.payee },
          rule: { category_id: evCat, sure: true, evidence: true, main_correct: true }, ai: null, rule_correct: true, ai_correct: null,
        });
        continue;
      }
      if (namesNoShop(s.merchant_text)) {
        out.evals.push({ task: 'sms_category', target_key: s.id, truth: { category_id: s.category_id, no_shop: true }, rule: null, ai: null, rule_correct: null, ai_correct: null });
        continue;
      }
      try {
        items.push({ i: rows.length, payload: { merchant: smsText(s.merchant_text), amount: Math.round(Number(s.amount)), kind: s.kind } });
        rows.push(s);
      } catch (err) {
        if (!(err instanceof UnsafePrompt)) throw err;
        out.evals.push({ task: 'sms_category', target_key: s.id, truth: { category_id: s.category_id }, rule: null, ai: { blocked: true }, rule_correct: null, ai_correct: null });
      }
    }
    const { decisions, usage } = await decide({
      task: 'sms_category', items, shared: { categories: cats.list }, steps, keys: env.keys, budget,
      fetchImpl: env.fetchImpl, labelOk: (a) => cats.toId.has(a.category),
    });
    out.usage.push(...usage);
    rows.forEach((s, i) => {
      const built = builtInCategory(bundle.categories, s.merchant_text);
      const d = decisions.get(i);
      const id = d?.answer ? cats.toId.get(d.answer.category) ?? null : null;
      out.evals.push({
        task: 'sms_category', target_key: s.id, truth: { category_id: s.category_id },
        rule: built ? { category_id: built, sure: true, main_correct: sameMain(bundle.categories, built, s.category_id) } : null,
        ai: d?.answer ? {
          category_id: id, confidence: d.confidence, pattern: d.pattern, models: d.votes.map((v) => v.model),
          main_correct: sameMain(bundle.categories, id, s.category_id),
        } : null,
        rule_correct: built ? categoryMatches(bundle.categories, built, s.category_id) : null,
        ai_correct: d?.answer ? categoryMatches(bundle.categories, id, s.category_id) : null,
      });
    });
  }

  const remaining = Math.max(0, evalLines.length - lineBatch.length) + Math.max(0, evalSms.length - smsBatch.length);
  out.stats = { evaluated: out.evals.length, remaining, ai_calls: out.usage.length, cost_usd: out.usage.reduce((a, u) => a + u.cost_usd, 0) };
  return { ...out, remaining, total };
}
