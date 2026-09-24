// Money formatting (CLAUDE.md rule 4): always LKR via Intl, en-LK, 2 decimals, mono in the UI.

const lkr = new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR' });
const lkrWhole = new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "LKR 4,620.00" (whatever the en-LK currency style prints — never hand-built). */
export function formatLKR(amount: number, opts: { whole?: boolean } = {}): string {
  return (opts.whole ? lkrWhole : lkr).format(amount);
}

/** "4,620.00" — for tables where the currency is in the header. */
export function formatAmount(amount: number): string {
  return plain.format(amount);
}

/** Round half away from zero to cents (avoids 0.1 + 0.2 drift when summing lines). */
export function toCents(amount: number): number {
  return Math.round((Math.abs(amount) + Number.EPSILON) * 100) * Math.sign(amount);
}

export function sumAmounts(amounts: number[]): number {
  return amounts.reduce((s, a) => s + toCents(a), 0) / 100;
}

/** Parse what a person types: "4,620", "4620.5", " 1 250 " → number (null when not a number). */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '').replace(/^(rs\.?|lkr)/i, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}
