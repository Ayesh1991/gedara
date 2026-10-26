// Booking from alerts (Phase 9c): the entries the inbox's one-tap answers make, built in one place so the
// web app ("Accept all", Save) and the matching run (booking by itself) make identical entries; which
// certain kinds Gedara may book by itself; and each kind's record on the household's own past bookings.
import { lineFingerprint } from '../scan/fingerprint.ts';
import { builtInCategory, payeeCategory, type CategoryLite } from './memory.ts';
import { billNameNorm } from './normalise.ts';
import { analyseInbox, namesNoShop, type AccountLite, type InboxAnalysis, type SmsRow, type Suggestion, type TxCandidate } from './sms.ts';

// ── The entries ──────────────────────────────────────────────────────────────
export function feeCategoryId(categories: CategoryLite[]): string | null {
  const services = categories.find((c) => c.parent_id === null && c.key === 'services');
  return categories.find((c) => c.parent_id === services?.id && c.name === 'Banking & fees')?.id ?? null;
}

const earliest = <T extends { received_at: string }>(rows: T[]): T => [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at))[0]!;

type AlertRow = Pick<SmsRow, 'received_at' | 'occurred_on' | 'occurred_at' | 'fingerprint' | 'merchant_text' | 'currency' | 'amount' | 'kind'>;

/** A transfer from a debit + payment pair (or an ATM withdrawal → Cash); the fee is its own expense. */
export function transferPayload(
  rows: AlertRow[], s: Extract<Suggestion, { kind: 'transfer' }>, householdId: string, categories: CategoryLite[],
) {
  const first = earliest(rows);
  return {
    household_id: householdId,
    type: 'transfer' as const,
    account_id: s.from,
    to_account_id: s.to,
    occurred_on: first.occurred_on,
    occurred_at: first.occurred_at,
    total: s.total,
    lines: [],
    fee: s.fee > 0 ? { amount: s.fee, category_id: feeCategoryId(categories) } : null,
  };
}

/** An expense / income / refund of one alert with one line (its shop name). */
export function alertEntryPayload(
  row: AlertRow,
  p: { householdId: string; type: 'expense' | 'income' | 'refund'; accountId: string; total: number; categoryId: string; name: string },
) {
  return {
    household_id: p.householdId,
    type: p.type,
    account_id: p.accountId,
    payee_text: row.merchant_text,
    occurred_on: row.occurred_on,
    occurred_at: row.occurred_at,
    total: p.total,
    notes: row.currency !== 'LKR' ? `${row.currency} ${row.amount}` : null,
    lines: [{ raw_name: p.name, category_id: p.categoryId, amount: p.total, fingerprint: lineFingerprint(row.fingerprint, 0, p.name, p.total) }],
  };
}

// ── What Gedara may book by itself ────────────────────────────────────────────
export const AUTO_KINDS = ['alert_link', 'alert_transfer', 'alert_note', 'category_evidence', 'category_rule', 'line_product'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];

/** A kind books by itself only when its record on past bookings is at least this good. */
export const AUTO_BAR = { right: 0.99, of: 20 };
export const AUTO_MAX = 50;

export interface KindRecord {
  right: number;
  of: number;
}
export type AutoRecord = Partial<Record<AutoKind, KindRecord>>;

export function qualifies(r: KindRecord | undefined): boolean {
  return !!r && r.of >= AUTO_BAR.of && r.right / r.of >= AUTO_BAR.right;
}

export interface AutoItem {
  kind: AutoKind;
  action: 'link' | 'post' | 'seen' | 'line';
  sms_ids: string[];
  tx_id?: string;
  payload?: Record<string, unknown>;
  line_id?: string;
  product_id?: string;
  /** what What changed shows */
  summary: {
    payee: string | null; amount: number | null; account_id: string | null; category_id?: string | null; to_account_id?: string | null;
    /** line_product: the product's name */
    product?: string | null;
  };
}

export interface AutoContext {
  householdId: string;
  sms: SmsRow[];
  analysis: InboxAnalysis;
  accounts: AccountLite[];
  categories: CategoryLite[];
  /** merchant_norm → remembered category (the household's memories) */
  memory: ReadonlyMap<string, string | null>;
  payees: ReadonlyMap<string, string>;
  /** alerts / lines a person undid once: never booked by itself again */
  undone: { sms: ReadonlySet<string>; lines: ReadonlySet<string> };
}

/** The card the inbox shows for an alert: one alert, or a transfer pair (debit + payment). */
function groups(fresh: SmsRow[], analysis: InboxAnalysis) {
  const byId = new Map(fresh.map((s) => [s.id, s]));
  const used = new Set<string>();
  const out: Array<{ rows: SmsRow[]; s: Suggestion }> = [];
  for (const s of fresh) {
    if (used.has(s.id)) continue;
    const sug = analysis.suggestions.get(s.id) ?? { kind: 'none' as const };
    const pair = sug.kind === 'transfer' && sug.pairId ? byId.get(sug.pairId) : undefined;
    used.add(s.id);
    if (pair) used.add(pair.id);
    out.push({ rows: pair ? [s, pair] : [s], s: sug });
  }
  return out;
}

/** The category a certain rule gives an expense alert, and which kind of certainty it is. */
export function certainCategory(
  row: SmsRow, s: Extract<Suggestion, { kind: 'expense' }>, ctx: Pick<AutoContext, 'categories' | 'memory' | 'payees'>,
): { kind: 'category_evidence' | 'category_rule'; categoryId: string } | null {
  if (s.evidence) {
    const id = payeeCategory(ctx.categories, ctx.payees, s.evidence);
    return id ? { kind: 'category_evidence', categoryId: id } : null;
  }
  const text = s.memo ?? row.merchant_text;
  if (namesNoShop(text)) return null; // a bank's own wording names no shop: one remembered choice is no proof
  const id = ctx.memory.get(billNameNorm(text)) ?? builtInCategory(ctx.categories, text);
  return id ? { kind: 'category_rule', categoryId: id } : null;
}

/** The alerts Gedara would book by itself now (for the kinds switched on), certain answers only. */
export function autobookAlerts(ctx: AutoContext, on: ReadonlySet<AutoKind>): AutoItem[] {
  const fresh = ctx.sms.filter((s) => !s.ignored && !s.transaction_id);
  const suspense = new Set(ctx.accounts.filter((a) => a.is_suspense).map((a) => a.id));
  const out: AutoItem[] = [];
  for (const { rows, s } of groups(fresh, ctx.analysis)) {
    if (rows.some((r) => ctx.undone.sms.has(r.id))) continue;
    const ids = rows.map((r) => r.id);
    const row = rows[0]!;
    const summary = { payee: row.merchant_text, amount: row.amount, account_id: row.account_id };
    if (s.kind === 'link' && s.confident && on.has('alert_link')) {
      out.push({ kind: 'alert_link', action: 'link', sms_ids: ids, tx_id: s.txId, summary });
    } else if (s.kind === 'transfer' && s.confident && on.has('alert_transfer')) {
      out.push({
        kind: 'alert_transfer', action: 'post', sms_ids: ids,
        payload: transferPayload(rows, s, ctx.householdId, ctx.categories),
        summary: { ...summary, amount: s.total, account_id: s.from, to_account_id: s.to },
      });
    } else if (s.kind === 'note' && s.confident && on.has('alert_note')) {
      out.push({ kind: 'alert_note', action: 'seen', sms_ids: ids, summary });
    } else if (s.kind === 'expense') {
      const lkr = ctx.analysis.lkr.get(row.id);
      const account = row.account_id ?? s.account;
      if (!account || suspense.has(account) || row.currency !== 'LKR' || lkr?.estimated || s.total === null || s.total <= 0) continue;
      const c = certainCategory(row, s, ctx);
      if (!c || !on.has(c.kind)) continue;
      const name = row.merchant_text ?? s.memo ?? '';
      if (!name) continue;
      out.push({
        kind: c.kind, action: 'post', sms_ids: ids,
        payload: alertEntryPayload(row, { householdId: ctx.householdId, type: 'expense', accountId: account, total: s.total, categoryId: c.categoryId, name }),
        summary: { ...summary, account_id: account, category_id: c.categoryId },
      });
    }
  }
  return out;
}

// ── The record: the rules replayed on the household's own decided alerts ──────
export interface BookedLite {
  sms_id: string;
  transaction_id: string;
  type: string;
  account_id: string;
  to_account_id: string | null;
  source: string;
  category_id: string | null;
}

/**
 * Each alert of the last 120 days that a person decided (booked or marked seen) is treated as new again;
 * the rules' certain answer is compared with what the person did. A kind's record is how often they agree.
 */
export function autobookRecord(
  p: Omit<AutoContext, 'analysis' | 'undone' | 'householdId'> & {
    booked: BookedLite[]; candidates: TxCandidate[];
    /** each replayed case (for a report of the disagreements) */
    onCase?: (kind: AutoKind, ok: boolean, smsIds: string[]) => void;
  },
): AutoRecord {
  const bySms = new Map(p.booked.map((b) => [b.sms_id, b]));
  if (!p.sms.some((s) => s.ignored || s.transaction_id)) return {};
  // entries made FROM alerts are not bills to link to; bills, Sheet rows and typed-in entries are
  const madeFromAlerts = new Set(p.booked.filter((b) => b.source === 'sms').map((b) => b.transaction_id));
  const asNew = p.sms.map((s) => ({ ...s, transaction_id: null, ignored: false }));
  const analysis = analyseInbox(asNew, p.candidates.filter((t) => !madeFromAlerts.has(t.id)), new Set(), p.accounts);
  const rec: AutoRecord = {};
  let ids: string[] = [];
  const add = (k: AutoKind, ok: boolean) => {
    const r = (rec[k] ??= { right: 0, of: 0 });
    r.of++;
    if (ok) r.right++;
    p.onCase?.(k, ok, ids);
  };
  const original = new Map(p.sms.map((s) => [s.id, s]));
  for (const { rows, s } of groups(asNew.filter((x) => original.get(x.id)!.ignored || original.get(x.id)!.transaction_id), analysis)) {
    const o = original.get(rows[0]!.id)!;
    const b = bySms.get(o.id);
    ids = rows.map((r) => r.id);
    if (s.kind === 'link' && s.confident) add('alert_link', o.transaction_id === s.txId);
    else if (s.kind === 'transfer' && s.confident) {
      add('alert_transfer', !!b && b.type === 'transfer' && b.account_id === s.from && b.to_account_id === s.to &&
        rows.every((r) => original.get(r.id)!.transaction_id === o.transaction_id));
    } else if (s.kind === 'note' && s.confident) add('alert_note', o.ignored && !o.transaction_id);
    else if (s.kind === 'expense' && s.total !== null) {
      const c = certainCategory(o, s, p);
      if (c) add(c.kind, !!b && b.type === 'expense' && b.category_id === c.categoryId);
    }
  }
  return rec;
}
