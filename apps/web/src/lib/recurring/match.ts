// Recurring bills: presets and "which bill already in Money pays this?" suggestions. Pure.
// Due dates themselves are computed by the database (v_recurring_due), never here.

export const EVERY_UNITS = ['day', 'week', 'month', 'year'] as const;
export type EveryUnit = (typeof EVERY_UNITS)[number];
export const USAGE_UNITS = ['kWh', 'm³', 'kg', 'L'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/** Quick presets (ledger v7 QUICK tiles): name, sub-category name to look for, units. */
export const PRESETS: { key: string; name: string; sub: string; usage: UsageUnit | null; every: [number, EveryUnit] }[] = [
  { key: 'ceb', name: 'CEB electricity', sub: 'Electricity', usage: 'kWh', every: [1, 'month'] },
  { key: 'water', name: 'NWSDB water', sub: 'Water bill', usage: 'm³', every: [1, 'month'] },
  { key: 'telecom', name: 'Mobile & internet', sub: 'Mobile & telephone', usage: null, every: [1, 'month'] },
  { key: 'gas', name: 'LP gas cylinder', sub: 'LP Gas', usage: null, every: [1, 'month'] },
  { key: 'insurance', name: 'Insurance', sub: 'Insurance', usage: null, every: [1, 'year'] },
];

export interface MatchRule {
  type: 'expense' | 'income';
  category_id: string | null;
  top_category_id: string | null;
  payee_text: string | null;
  expected_amount: number | null;
  last_amount: number | null;
  next_due: string | null;
}

export interface MatchTx {
  id: string;
  type: string;
  occurred_on: string;
  total: number;
  payee_text: string | null;
  recurring_id: string | null;
  category_ids: string[];
}

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Transactions that probably pay this bill: same type, not already linked, within ±10 days of the
 * due date, the same category (or the same payee) and — when an amount is known — within ±20 %.
 * Best first: category + payee match, then closest date.
 */
export function suggestPayments(rule: MatchRule, txs: MatchTx[]): MatchTx[] {
  if (!rule.next_due) return [];
  const amount = rule.expected_amount ?? rule.last_amount;
  const payee = norm(rule.payee_text);
  const scored: { tx: MatchTx; score: number }[] = [];
  for (const tx of txs) {
    if (tx.type !== rule.type || tx.recurring_id) continue;
    const days = Math.abs(dayDiff(tx.occurred_on, rule.next_due));
    if (days > 10) continue;
    const sameCat = rule.category_id !== null && tx.category_ids.includes(rule.category_id);
    const samePayee = payee !== '' && norm(tx.payee_text).includes(payee);
    if (!sameCat && !samePayee) continue;
    if (amount !== null && amount > 0 && Math.abs(tx.total - amount) > amount * 0.2) continue;
    scored.push({ tx, score: (sameCat ? 2 : 0) + (samePayee ? 2 : 0) - days / 10 });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.tx);
}

/** Human "every" text parts for i18n: [n, unit]. */
export function everyKey(n: number, unit: EveryUnit): { key: `recurring.every.${EveryUnit}`; count: number } {
  return { key: `recurring.every.${unit}`, count: n };
}
