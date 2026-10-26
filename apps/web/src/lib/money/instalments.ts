// Instalment plans (Phase 9b.2): card instalment plans and loans. A plan stores only a few facts — the
// monthly amount, how many months, the date of the first instalment and, for a loan, the amount borrowed
// and the yearly rate — and everything on Money › Instalments is worked out here from those facts and
// today's date, so nothing has to be updated month by month.

export interface PlanFacts {
  kind: 'card' | 'loan';
  monthly: number;
  total_count: number;
  /** YYYY-MM-DD of instalment 1; the others fall on the same day of each month (or the month's last day). */
  first_on: string;
  principal?: number | null;
  annual_rate?: number | null;
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The date of instalment `n` (1-based): the first date moved on by n − 1 months, kept inside the month. */
export function instalmentDate(first_on: string, n: number): string {
  const [y, m, d] = first_on.split('-').map(Number) as [number, number, number];
  const months = m - 1 + (n - 1);
  const year = y + Math.floor(months / 12);
  const month = (months % 12) + 1;
  return ymd(year, month, Math.min(d, daysIn(year, month)));
}

/** The first date, from "instalment `current` of the plan fell on `on`" (what a statement shows). */
export function firstFromCurrent(on: string, current: number): string {
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  const months = y * 12 + (m - 1) - (current - 1);
  const year = Math.floor(months / 12);
  const month = (months % 12) + 1;
  return ymd(year, month, Math.min(d, daysIn(year, month)));
}

/** How many instalments have fallen due by `today` (0 … total_count). */
export function paidCount(p: PlanFacts, today: string): number {
  if (today < p.first_on) return 0;
  let lo = 1;
  let hi = p.total_count;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (instalmentDate(p.first_on, mid) <= today) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface LoanSplit {
  /** owed now (after the instalments already paid) */
  owed: number;
  /** of the next instalment: interest and repayment */
  nextInterest: number;
  nextPrincipal: number;
  /** interest still to pay over the remaining instalments */
  interestLeft: number;
}

/** A loan's balance and the next instalment's split (monthly rate = yearly ÷ 12; standard reducing balance). */
export function loanSplit(p: PlanFacts, paid: number): LoanSplit | null {
  if (p.kind !== 'loan' || !p.principal || p.annual_rate == null) return null;
  const r = p.annual_rate / 100 / 12;
  const grow = (1 + r) ** paid;
  const owed = r === 0 ? p.principal - p.monthly * paid : p.principal * grow - (p.monthly * (grow - 1)) / r;
  const left = p.total_count - paid;
  const nextInterest = left > 0 ? owed * r : 0;
  return {
    owed: round2(Math.max(0, owed)),
    nextInterest: round2(nextInterest),
    nextPrincipal: left > 0 ? round2(Math.min(owed, p.monthly - nextInterest)) : 0,
    interestLeft: round2(Math.max(0, p.monthly * left - owed)),
  };
}

/** A loan's monthly instalment from its amount, yearly rate and months (to check what the bank charges). */
export function loanInstalment(principal: number, annualRate: number, months: number): number {
  const r = annualRate / 100 / 12;
  return round2(r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months));
}

export interface PlanStatus {
  /** instalments fallen due so far, and the one shown as "now" (the latest, or the first if none yet) */
  paid: number;
  current: number;
  left: number;
  /** the next instalment's date (null when done) and the last one's */
  nextOn: string | null;
  lastOn: string;
  /** what is still to pay (instalments not yet due × monthly) */
  leftToPay: number;
  done: boolean;
  loan: LoanSplit | null;
}

export function planStatus(p: PlanFacts, today: string): PlanStatus {
  const paid = paidCount(p, today);
  const left = p.total_count - paid;
  return {
    paid,
    current: Math.max(1, paid),
    left,
    nextOn: left > 0 ? instalmentDate(p.first_on, paid + 1) : null,
    lastOn: instalmentDate(p.first_on, p.total_count),
    leftToPay: round2(left * p.monthly),
    done: left === 0,
    loan: loanSplit(p, paid),
  };
}

/** Is an instalment of this plan due in the month of `month` (YYYY-MM)? */
export function dueInMonth(p: PlanFacts, month: string): boolean {
  const first = p.first_on.slice(0, 7);
  const last = instalmentDate(p.first_on, p.total_count).slice(0, 7);
  return month >= first && month <= last;
}

/** The months when the monthly total drops (a plan's last instalment), soonest first. */
export function endings<T extends PlanFacts>(plans: T[], today: string): Array<{ month: string; plans: T[]; drop: number }> {
  const by = new Map<string, T[]>();
  for (const p of plans) {
    const last = instalmentDate(p.first_on, p.total_count);
    if (last < today) continue;
    const key = last.slice(0, 7);
    by.set(key, [...(by.get(key) ?? []), p]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, ps]) => ({ month, plans: ps, drop: round2(ps.reduce((s, p) => s + p.monthly, 0)) }));
}

/** People's "12-months instalment plan for LKR 123,456.00/= transaction at X successfully created". */
export function planFromAlert(body: string): { months: number; total: number } | null {
  const m = /(\d{1,3})\s*-?\s*months?\s+instal+ment\s+plan\s+for\s+(?:LKR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(body);
  if (!m) return null;
  const months = Number(m[1]);
  const total = Number(m[2]!.replace(/,/g, ''));
  return months > 0 && total > 0 ? { months, total } : null;
}
