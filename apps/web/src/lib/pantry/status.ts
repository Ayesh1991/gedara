// Pantry status chips (MASTER_PLAN §5.2, §0.1 #3). Expiry (unsafe, red) and best-before (quality,
// amber) are different things: a spice past its best-before is usually still fine. Computed here,
// not in SQL, so the "due soon" window stays cheap to tune.

export type DueType = 'none' | 'best_before' | 'expiry';
export type StockStatus = 'expired' | 'bbPassed' | 'dueSoon' | 'belowMin' | 'opened' | 'out';
export type StatusFilter = 'all' | 'attention' | StockStatus;

export const DUE_SOON_DAYS = 5;
export const EXTEND_DAYS = 30;

/** Whole days from `from` to `to` (ISO dates, 'YYYY-MM-DD'); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The due state of one date: passed (red or amber by type), due within the window, or fine. */
export function dueState(
  dueType: DueType | string,
  due: string | null | undefined,
  today: string,
  soonDays = DUE_SOON_DAYS,
): 'expired' | 'bbPassed' | 'dueSoon' | null {
  if (!due || dueType === 'none') return null;
  const left = daysBetween(today, due);
  if (left < 0) return dueType === 'expiry' ? 'expired' : 'bbPassed';
  if (left <= soonDays) return 'dueSoon';
  return null;
}

export interface StockFacts {
  due_type: DueType | string;
  next_due: string | null;
  qty: number;
  qty_opened: number;
  below_min: boolean;
}

/** Every chip that applies, most urgent first. */
export function stockStatuses(p: StockFacts, today: string): StockStatus[] {
  const out: StockStatus[] = [];
  if (p.qty > 0) {
    const due = dueState(p.due_type, p.next_due, today);
    if (due) out.push(due);
  }
  if (p.below_min) out.push('belowMin');
  if (p.qty_opened > 0) out.push('opened');
  if (p.qty <= 0) out.push('out');
  return out;
}

/** Needs a look: anything past or near its date, or running low. */
export const ATTENTION: ReadonlySet<StockStatus> = new Set(['expired', 'bbPassed', 'dueSoon', 'belowMin']);

export function matchesFilter(statuses: StockStatus[], filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return statuses.some((s) => ATTENTION.has(s));
  return statuses.includes(filter);
}

/** Tailwind classes per status — the fixed status colours of rule 11. */
export const STATUS_TONE: Record<StockStatus, string> = {
  expired: 'bg-red/15 text-red',
  bbPassed: 'bg-caution/15 text-caution',
  dueSoon: 'bg-due/15 text-due',
  belowMin: 'bg-info/15 text-info',
  opened: 'bg-info/10 text-info',
  out: 'bg-white/[0.06] text-muted',
};
