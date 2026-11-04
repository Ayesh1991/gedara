// Ask Gedara (Phase 10): a plan's result → a short answer. Pure and plain: the answer is an i18n sentence
// with values (text, money, counts, dates) and rows, each linking only to one of Gedara's own pages. Every
// value comes from the database (the AI never writes a number); names from the database are only ever
// shown as text — never HTML, markdown, images or outside links. Results are checked with Zod first.
import { z } from 'zod';
import type { AskCall, AskTool } from '@ask/plan';
import type { Target } from '@/lib/attention';

/** A value placed into a sentence: the component shows money, counts and dates in IBM Plex Mono. */
export type Val =
  | { text: string }
  | { money: number }
  | { num: number }
  | { day: string }
  | { month: string }
  | { qty: number; unit: string | null };

export interface Line {
  key: string;
  vars?: Record<string, Val>;
  /** plural selection (not printed; print with {{n}}) */
  count?: number;
}

export interface Row {
  label: Val;
  detail?: Line;
  value?: Val;
  tone?: 'red' | 'amber' | 'teal';
  link?: Target;
}

/** Another reading of `about` the person can tap: re-runs the same call without the AI. */
export interface Chip {
  label: Val;
  kindKey: string;
  call: AskCall;
}

export interface Answer {
  tool: AskTool;
  /** what was counted ("Fish & seafood"), shown above the sentence so a wrong reading is visible */
  subject?: Line;
  head: Line;
  rows: Row[];
  /** "Open in Gedara": where the numbers came from */
  open?: Target;
  chips: Chip[];
  empty: boolean;
}

// ── Links: only these pages, only with uuid ids ───────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGES = new Set([
  '/money', '/money/tx/$txId', '/money/recurring', '/money/instalments', '/money/budgets', '/money/accounts/$accountId',
  '/insights/$area', '/pantry', '/pantry/$productId', '/things/$assetId', '/places/$placeId',
]);

/** A target only if it is one of Gedara's own pages with well-formed ids; anything else is dropped. */
export function safeTarget(t: Target | null | undefined): Target | undefined {
  if (!t || !PAGES.has(t.to)) return undefined;
  for (const v of Object.values(t.params ?? {})) if (!UUID.test(v) && !['spend', 'pantry'].includes(v)) return undefined;
  for (const v of Object.values(t.search ?? {})) {
    if (typeof v !== 'string' || v.length > 60 || /[<>]|:\/\//.test(v)) return undefined;
  }
  return t;
}

const tx = (id: string) => safeTarget({ to: '/money/tx/$txId', params: { txId: id } });
const product = (id: string) => safeTarget({ to: '/pantry/$productId', params: { productId: id } });
const thing = (id: string) => safeTarget({ to: '/things/$assetId', params: { assetId: id } });
const place = (id: string) => safeTarget({ to: '/places/$placeId', params: { placeId: id } });

// ── Result shapes (as migration 100 returns them) ─────────────────────────────
const n = z.coerce.number();
const nn = n.nullable();
const s = z.string();
const sn = s.nullable();
const id = z.uuid();
const Match = z.object({
  kind: z.enum(['category', 'sub', 'product', 'shop', 'words', 'all']),
  id: id.nullish(),
  name: sn.optional(),
  also: z.array(z.object({ kind: z.enum(['category', 'sub', 'product', 'shop', 'words']), id: id.nullish(), name: s })).default([]),
});
const SpendR = z.object({
  from: s, to: s, match: Match, total: n, lines: n, bills: n,
  groups: z.array(z.object({ name: s, id: id.nullish(), total: n, bills: n })),
});
const TxR = z.object({
  from: s, to: s, match: Match, count: n, total: n,
  rows: z.array(z.object({ id, date: s, payee: sn, account: sn, amount: n })),
});
const DueR = z.object({
  from: s, to: s, count: n, total: n,
  rows: z.array(z.object({ kind: z.enum(['bill', 'instalment']), id, name: s, date: s, amount: nn, account: sn, overdue: z.boolean() })),
});
const InstR = z.object({
  about: sn, monthly_total: n,
  rows: z.array(z.object({
    id, name: s, kind: z.enum(['card', 'loan']), account: s, monthly: n, total_count: n, paid: n, left: n,
    next_on: sn, last_on: s, left_to_pay: n, owed: nn,
  })),
});
const FindR = z.object({
  about: s,
  rows: z.array(z.object({
    kind: z.enum(['thing', 'product', 'place']), id, name: s, place_id: id.nullable(), place: sn, status: sn, lent_to: sn,
    qty: nn, unit: sn,
  })),
});
const PantryR = z.object({
  view: z.enum(['runout', 'expiring', 'below_min']), within_days: n.optional(), today: s,
  rows: z.array(z.object({
    id, name: s, days: nn.optional(), date: sn.optional(), due_type: sn.optional(), qty: nn.optional(), min: nn.optional(),
    unit: sn.optional(), place: sn.optional(),
  })),
});
const BalR = z.object({
  about: sn,
  rows: z.array(z.object({
    id, name: s, kind: s, institution: sn, last4: z.string().regex(/^\d{3,4}$/).nullable(), balance: n, available: nn,
    credit_limit: nn, last_on: sn,
  })),
});
const BudgetR = z.object({ month: s, rows: z.array(z.object({ id, name: s, budget: n, spent: n, left: n })) });
const WarrR = z.object({ within_days: n, rows: z.array(z.object({ id, name: s, date: s, days: n })) });

// ── Helpers ───────────────────────────────────────────────────────────────────
const month = (day: string) => day.slice(0, 7);
const text = (v: string): Val => ({ text: v });

function whatOf(m: z.infer<typeof Match>, parentOf: (catId: string) => string | null): { what: Line; open?: Target } {
  switch (m.kind) {
    case 'all':
      return { what: { key: 'ask.what.all' }, open: undefined };
    case 'category':
      return { what: { key: 'ask.what.named', vars: { name: text(m.name ?? '') } }, open: m.id ? { to: '/insights/$area', params: { area: 'spend' }, search: { cat: m.id } } : undefined };
    case 'sub': {
      const parent = m.id ? parentOf(m.id) : null;
      return {
        what: { key: 'ask.what.named', vars: { name: text(m.name ?? '') } },
        open: m.id ? { to: '/insights/$area', params: { area: 'spend' }, search: parent ? { cat: parent, sub: m.id } : { cat: m.id } } : undefined,
      };
    }
    case 'product':
      return { what: { key: 'ask.what.named', vars: { name: text(m.name ?? '') } }, open: m.id ? { to: '/insights/$area', params: { area: 'spend' }, search: { product: m.id } } : undefined };
    case 'shop':
      return { what: { key: 'ask.what.shop', vars: { name: text(m.name ?? '') } } };
    case 'words':
      return { what: { key: 'ask.what.words', vars: { name: text(m.name ?? '') } } };
  }
}

function spendOpen(m: z.infer<typeof Match>, base: Target | undefined, from: string, to: string): Target | undefined {
  if (base) return safeTarget({ ...base, search: { ...base.search, from: month(from), to: month(to) } });
  if (m.kind === 'all') return safeTarget({ to: '/insights/$area', params: { area: 'spend' }, search: { from: month(from), to: month(to) } });
  // a shop or words: Money's search, for the last month of the range
  return safeTarget({ to: '/money', search: { q: (m.name ?? '').slice(0, 60), month: month(to) } });
}

function chipsFor(call: AskCall, m: z.infer<typeof Match>): Chip[] {
  if (call.tool !== 'ask_spend' && call.tool !== 'ask_transactions') return [];
  return m.also.slice(0, 4).map((a) => ({
    label: text(a.name),
    kindKey: `ask.kind.${a.kind}`,
    call: {
      ...call,
      args: { ...call.args, p_kind: a.kind, p_id: a.id ?? null, p_about: a.kind === 'shop' || a.kind === 'words' ? a.name.slice(0, 60) : call.args.p_about },
    } as AskCall,
  }));
}

export interface RenderCtx {
  /** a sub-category's main category (for Insights links), or null */
  parentOf(catId: string): string | null;
}

/** One call and its database result → an answer; null when the result isn't what migration 100 returns. */
export function renderAnswer(call: AskCall, result: unknown, ctx: RenderCtx): Answer | null {
  switch (call.tool) {
    case 'ask_spend': {
      const r = SpendR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const { what, open } = whatOf(d.match, ctx.parentOf);
      const empty = d.lines === 0;
      return {
        tool: call.tool,
        subject: what,
        head: empty
          ? { key: 'ask.spend.none', vars: { from: { day: d.from }, to: { day: d.to } } }
          : { key: 'ask.spend.head', vars: { total: { money: d.total }, n: { num: d.bills }, from: { day: d.from }, to: { day: d.to } }, count: d.bills },
        rows: d.groups.map((g) => ({ label: text(g.name), value: { money: g.total } as Val, detail: { key: 'ask.bills', vars: { n: { num: g.bills } }, count: g.bills } })),
        open: spendOpen(d.match, open, d.from, d.to),
        chips: chipsFor(call, d.match),
        empty,
      };
    }
    case 'ask_transactions': {
      const r = TxR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const { what, open } = whatOf(d.match, ctx.parentOf);
      return {
        tool: call.tool,
        subject: what,
        head: d.count === 0
          ? { key: 'ask.tx.none', vars: { from: { day: d.from }, to: { day: d.to } } }
          : { key: 'ask.tx.head', vars: { n: { num: d.count }, total: { money: d.total }, from: { day: d.from }, to: { day: d.to } }, count: d.count },
        rows: d.rows.map((x): Row => ({
          label: text(x.payee ?? '—'), value: { money: x.amount } as Val, link: tx(x.id),
          detail: { key: 'ask.tx.row', vars: { date: { day: x.date }, account: text(x.account ?? '') } },
        })),
        open: spendOpen(d.match, open, d.from, d.to),
        chips: chipsFor(call, d.match),
        empty: d.count === 0,
      };
    }
    case 'ask_due': {
      const r = DueR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      return {
        tool: call.tool,
        head: d.count === 0
          ? { key: 'ask.due.none', vars: { from: { day: d.from }, to: { day: d.to } } }
          : { key: 'ask.due.head', vars: { n: { num: d.count }, total: { money: d.total }, from: { day: d.from }, to: { day: d.to } }, count: d.count },
        rows: d.rows.map((x): Row => ({
          label: text(x.name),
          value: x.amount === null ? undefined : { money: x.amount },
          tone: x.overdue ? ('red' as const) : undefined,
          detail: { key: x.overdue ? 'ask.due.overdue' : x.kind === 'bill' ? 'ask.due.bill' : 'ask.due.instalment', vars: { date: { day: x.date } } },
          link: safeTarget({ to: x.kind === 'bill' ? '/money/recurring' : '/money/instalments' }),
        })),
        open: safeTarget({ to: '/money/recurring' }),
        chips: [],
        empty: d.count === 0,
      };
    }
    case 'ask_instalments': {
      const r = InstR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const one = d.rows.length === 1 ? d.rows[0]! : null;
      // asked about a plan by name, none matched, so all running plans came back (runForAnswer)
      const fellBack = !!call.args.p_about && d.about === null && d.rows.length > 0;
      return {
        tool: call.tool,
        head: fellBack
          ? { key: 'ask.inst.noMatchAll', vars: { about: text(call.args.p_about ?? ''), n: { num: d.rows.length }, monthly: { money: d.monthly_total } }, count: d.rows.length }
          : d.rows.length === 0
          ? { key: d.about ? 'ask.inst.noneAbout' : 'ask.inst.none', vars: { about: text(d.about ?? '') } }
          : one
            ? { key: one.left > 0 ? 'ask.inst.one' : 'ask.inst.done', vars: { name: text(one.name), last: { day: one.last_on }, left: { num: one.left }, total: { num: one.total_count } } }
            : { key: 'ask.inst.many', vars: { n: { num: d.rows.length }, monthly: { money: d.monthly_total } }, count: d.rows.length },
        rows: d.rows.map((x): Row => ({
          label: text(x.name),
          value: { money: x.owed ?? x.left_to_pay },
          detail: x.left > 0
            ? { key: x.owed !== null ? 'ask.inst.rowLoan' : 'ask.inst.row', vars: { monthly: { money: x.monthly }, left: { num: x.left }, total: { num: x.total_count }, next: { day: x.next_on ?? x.last_on }, last: { day: x.last_on }, account: text(x.account) } }
            : { key: 'ask.inst.rowDone', vars: { last: { day: x.last_on } } },
          link: safeTarget({ to: '/money/instalments' }),
        })),
        open: safeTarget({ to: '/money/instalments' }),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
    case 'ask_find': {
      const r = FindR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      return {
        tool: call.tool,
        head: d.rows.length === 0 ? { key: 'ask.find.none', vars: { about: text(d.about) } } : { key: 'ask.find.head', vars: { about: text(d.about) } },
        rows: d.rows.map((x): Row => {
          if (x.kind === 'thing') {
            return {
              label: text(x.name),
              detail: x.status === 'lent' && x.lent_to
                ? { key: 'ask.find.lent', vars: { who: text(x.lent_to) } }
                : x.place ? { key: 'ask.find.at', vars: { place: text(x.place) } } : { key: 'ask.find.noPlace' },
              link: thing(x.id),
            };
          }
          if (x.kind === 'product') {
            return {
              label: text(x.name),
              detail: x.qty !== null && x.qty > 0
                ? { key: x.place ? 'ask.find.stockAt' : 'ask.find.stock', vars: { qty: { qty: x.qty, unit: x.unit }, place: text(x.place ?? '') } }
                : { key: 'ask.find.noStock' },
              link: product(x.id),
            };
          }
          return { label: text(x.name), detail: { key: 'ask.find.place', vars: { place: text(x.place ?? x.name) } }, link: place(x.id) };
        }),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
    case 'ask_pantry': {
      const r = PantryR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const days = { num: d.within_days ?? 0 };
      return {
        tool: call.tool,
        head: { key: d.rows.length === 0 ? `ask.pantry.${d.view}None` : `ask.pantry.${d.view}`, vars: { n: { num: d.rows.length }, days }, count: d.rows.length },
        rows: d.rows.map((x): Row => ({
          label: text(x.name),
          detail:
            d.view === 'runout'
              ? { key: 'ask.pantry.inDays', vars: { n: { num: x.days ?? 0 } }, count: x.days ?? 0 }
              : d.view === 'expiring'
                ? { key: (x.date ?? '') < d.today ? 'ask.pantry.expired' : x.due_type === 'best_before' ? 'ask.pantry.bestBefore' : 'ask.pantry.expires', vars: { date: { day: x.date ?? d.today } } }
                : { key: 'ask.pantry.min', vars: { min: { qty: x.min ?? 0, unit: x.unit ?? null } } },
          value: x.qty !== null && x.qty !== undefined ? ({ qty: x.qty, unit: x.unit ?? null } as Val) : undefined,
          tone: d.view === 'expiring' && (x.date ?? '') < d.today ? ('red' as const) : d.view === 'expiring' ? ('amber' as const) : undefined,
          link: product(x.id),
        })),
        open: safeTarget({ to: '/pantry' }),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
    case 'ask_balances': {
      const r = BalR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const owes = (k: string) => k === 'credit_card' || k === 'loan';
      return {
        tool: call.tool,
        head: d.rows.length === 0 ? { key: 'ask.bal.none', vars: { about: text(d.about ?? '') } } : { key: 'ask.bal.head' },
        rows: d.rows.map((x): Row => ({
          label: text(x.last4 ? `${x.name} ··${x.last4}` : x.name),
          value: { money: owes(x.kind) && x.balance < 0 ? -x.balance : x.balance },
          detail: owes(x.kind) && x.balance < 0
            ? { key: x.available !== null && x.kind === 'credit_card' ? 'ask.bal.owedAvail' : 'ask.bal.owed', vars: { available: { money: x.available ?? 0 } } }
            : { key: 'ask.bal.balance' },
          tone: x.balance < 0 && !owes(x.kind) ? ('red' as const) : undefined,
          link: safeTarget({ to: '/money/accounts/$accountId', params: { accountId: x.id } }),
        })),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
    case 'ask_budget': {
      const r = BudgetR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      const over = d.rows.filter((x) => x.left < 0).length;
      return {
        tool: call.tool,
        head: d.rows.length === 0
          ? { key: 'ask.budget.none', vars: { month: { month: month(d.month) } } }
          : { key: over ? 'ask.budget.over' : 'ask.budget.ok', vars: { month: { month: month(d.month) }, n: { num: over } }, count: over },
        rows: d.rows.map((x): Row => ({
          label: text(x.name),
          value: { money: Math.abs(x.left) },
          tone: x.left < 0 ? ('red' as const) : ('teal' as const),
          detail: { key: x.left < 0 ? 'ask.budget.rowOver' : 'ask.budget.rowLeft', vars: { spent: { money: x.spent }, budget: { money: x.budget } } },
          link: safeTarget({ to: '/money/budgets' }),
        })),
        open: safeTarget({ to: '/money/budgets' }),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
    case 'ask_warranty': {
      const r = WarrR.safeParse(result);
      if (!r.success) return null;
      const d = r.data;
      return {
        tool: call.tool,
        head: { key: d.rows.length === 0 ? 'ask.warranty.none' : 'ask.warranty.head', vars: { n: { num: d.rows.length }, days: { num: d.within_days } }, count: d.rows.length },
        rows: d.rows.map((x): Row => ({
          label: text(x.name),
          detail: { key: 'ask.warranty.row', vars: { date: { day: x.date }, n: { num: x.days } }, count: x.days },
          tone: x.days <= 14 ? ('amber' as const) : undefined,
          link: thing(x.id),
        })),
        chips: [],
        empty: d.rows.length === 0,
      };
    }
  }
}

/** Every value of an answer that is a number (money, counts, quantities) — for the accuracy run. */
export function numbersOf(a: Answer): number[] {
  const out: number[] = [];
  const add = (v?: Val) => {
    if (!v) return;
    if ('money' in v) out.push(v.money);
    else if ('num' in v) out.push(v.num);
    else if ('qty' in v) out.push(v.qty);
  };
  const line = (l?: Line) => Object.values(l?.vars ?? {}).forEach(add);
  line(a.head);
  for (const r of a.rows) {
    add(r.value);
    line(r.detail);
  }
  return out;
}
