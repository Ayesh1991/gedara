// What a thing is worth and what it has cost (MASTER_PLAN §3.5, §6 Things). Mirrors the SQL view
// `v_asset` (migration 39) so forms can preview the numbers before saving; the list and the asset
// page show the view's values.

export const WARRANTY_SOON_DAYS = 30;
export const SERVICE_SOON_DAYS = 7;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): [number, number, number] {
  const m = ISO.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whole months from `from` to `to`, like Postgres `age()` (a month counts once its day is reached). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, months);
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

const GONE = new Set(['sold', 'disposed', 'lost']);

export interface ValueInput {
  purchase_price: number | null;
  purchased_on: string | null;
  useful_life_months: number | null;
  salvage_value: number | null;
  status: string;
  sold_on: string | null;
  sold_price: number | null;
  maintenance_cost?: number | null;
}

export interface AssetValue {
  monthsOwned: number | null;
  bookValue: number | null;
  currentValue: number | null;
  costOfOwnership: number | null;
  costPerMonth: number | null;
  saleGain: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Straight-line depreciation and cost of ownership, as of `today` (or the day it left). */
export function assetValue(a: ValueInput, today: string): AssetValue {
  const gone = GONE.has(a.status);
  const end = gone ? (a.sold_on ?? today) : today;
  const monthsOwned = a.purchased_on ? monthsBetween(a.purchased_on, end) : null;
  let bookValue: number | null = null;
  if (a.purchase_price !== null) {
    if (!a.useful_life_months || monthsOwned === null) bookValue = a.purchase_price;
    else {
      const salvage = Math.min(a.salvage_value ?? 0, a.purchase_price);
      bookValue = round2(a.purchase_price - (a.purchase_price - salvage) * Math.min(monthsOwned / a.useful_life_months, 1));
    }
  }
  const maint = a.maintenance_cost ?? 0;
  const costOfOwnership = a.purchase_price === null ? null : round2(a.purchase_price + maint - (a.sold_price ?? 0));
  return {
    monthsOwned,
    bookValue,
    currentValue: bookValue === null ? null : gone ? 0 : bookValue,
    costOfOwnership,
    costPerMonth: costOfOwnership === null || monthsOwned === null ? null : round2(costOfOwnership / Math.max(monthsOwned, 1)),
    saleGain: a.status === 'sold' && a.sold_price !== null && bookValue !== null ? round2(a.sold_price - bookValue) : null,
  };
}

export type WarrantyState = 'lifetime' | 'active' | 'ending' | 'expired' | 'none';

export function warrantyState(
  a: { lifetime_warranty: boolean; warranty_until: string | null },
  today: string,
): { state: WarrantyState; daysLeft: number | null } {
  if (a.lifetime_warranty) return { state: 'lifetime', daysLeft: null };
  if (!a.warranty_until) return { state: 'none', daysLeft: null };
  const daysLeft = daysBetween(today, a.warranty_until);
  return { state: daysLeft < 0 ? 'expired' : daysLeft <= WARRANTY_SOON_DAYS ? 'ending' : 'active', daysLeft };
}

/** Status colour classes (CLAUDE.md rule 11: amber best-before / ending, cyan due, violet info, teal good, red unsafe). */
export const WARRANTY_TONE: Record<WarrantyState, string> = {
  lifetime: 'bg-teal/15 text-teal',
  active: 'bg-teal/15 text-teal',
  ending: 'bg-caution/15 text-caution',
  expired: 'bg-white/10 text-muted',
  none: '',
};

/** A starting guess for "useful life" by sub-category name (months); the user can change it. */
const LIFE_BY_NAME: Array<[RegExp, number]> = [
  [/electronics|computer|phone/i, 48],
  [/appliance/i, 96],
  [/furniture/i, 120],
  [/kitchenware/i, 60],
  [/tool/i, 84],
  [/vehicle|car|bike|motor/i, 120],
];

export function suggestedLifeMonths(categoryName: string | null | undefined): number | null {
  if (!categoryName) return null;
  for (const [re, months] of LIFE_BY_NAME) if (re.test(categoryName)) return months;
  return null;
}

/** "A-0042" — the human tag printed under the QR. */
export function assetTag(no: number): string {
  return `A-${String(no).padStart(4, '0')}`;
}

/** Add days to an ISO day. */
export function addDaysIso(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
