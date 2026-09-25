// The drill-down contract (MASTER_PLAN §6, §4 row 10): Domain → Category → Sub-category / Product →
// the record. The whole path lives in the URL (/insights/<area>?from&to&cat&sub&product|name…), so any
// view is bookmarkable and opens the same on the phone and the iPad. Pure: no Supabase import.
import { z } from 'zod';
import { idParam, monthParam, textParam } from '../search';
import { addMonths } from '../time';

export const AREAS = ['cashflow', 'spend', 'prices', 'pantry', 'things', 'utilities', 'places'] as const;
export type Area = (typeof AREAS)[number];

/** Spend grouped another way than by category (the domain level only). */
export const SPEND_BY = ['category', 'merchant', 'account', 'kind', 'time'] as const;
export type SpendBy = (typeof SPEND_BY)[number];

export const PANTRY_VIEWS = ['flow', 'waste', 'velocity', 'places'] as const;
export type PantryView = (typeof PANTRY_VIEWS)[number];

const ACCOUNT_KINDS = ['cash', 'bank', 'credit_card', 'wallet', 'loan', 'investment'] as const;

export const InsightsSearchSchema = z.object({
  from: monthParam().optional(),
  to: monthParam().optional(),
  cat: idParam().optional(),
  sub: idParam().optional(),
  product: idParam().optional(),
  /** A printed bill-line name, for lines that aren't linked to a product. */
  name: textParam(200).optional(),
  merchant: idParam().optional(),
  account: idParam().optional(),
  kind: z.enum(ACCOUNT_KINDS).optional(),
  recurring: z.enum(['yes', 'no']).optional(),
  /** Heatmap cell: ISO weekday 1–7 and hour 0–23 ('none' = bills without a time). Records only. */
  weekday: textParam(1).pipe(z.string().regex(/^[1-7]$/)).optional(),
  hour: textParam(4).pipe(z.string().regex(/^(1?[0-9]|2[0-3]|none)$/)).optional(),
  by: z.enum(SPEND_BY).optional(),
  view: z.enum(PANTRY_VIEWS).optional(),
});
export type InsightsSearch = z.infer<typeof InsightsSearchSchema>;

/** The filters that narrow the records (everything but the period and the presentation). */
export const FILTER_KEYS = ['cat', 'sub', 'product', 'name', 'merchant', 'account', 'kind', 'recurring', 'weekday', 'hour'] as const;

export interface Period {
  from: string; // 'YYYY-MM'
  to: string; // 'YYYY-MM' (inclusive)
}

/** Default = the last 12 months up to this one; `from` alone = that one month. */
export function periodOf(s: Pick<InsightsSearch, 'from' | 'to'>, today: string): Period {
  const thisMonth = today.slice(0, 7);
  if (s.from && s.to) return s.from <= s.to ? { from: s.from, to: s.to } : { from: s.to, to: s.from };
  if (s.from) return { from: s.from, to: s.from };
  if (s.to) return { from: addMonths(s.to, -11), to: s.to };
  return { from: addMonths(thisMonth, -11), to: thisMonth };
}

/** Inclusive date range of a period. */
export function periodDates(p: Period): { from: string; to: string } {
  const [y, m] = p.to.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${p.from}-01`, to: `${p.to}-${String(last).padStart(2, '0')}` };
}

/** Months from…to, oldest first. */
export function monthsOf(p: Period): string[] {
  const out: string[] = [];
  for (let m = p.from; m <= p.to && out.length < 120; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function isSingleMonth(p: Period): boolean {
  return p.from === p.to;
}

export type SpendLevel = 'domain' | 'category' | 'item' | 'records';

/**
 * Which level the spend view is at. A main category without sub-categories skips straight to its
 * products; a product or a printed name is the record list (its bill lines).
 */
export function spendLevel(s: InsightsSearch, catHasSubs: boolean): SpendLevel {
  if (s.product || s.name || s.weekday) return 'records';
  if (s.sub) return 'item';
  if (s.cat) return catHasSubs ? 'category' : 'item';
  return 'domain';
}

/** What insights_spend groups by at a level. */
export function spendGroupBy(level: SpendLevel, by: SpendBy | undefined): string {
  if (level === 'category') return 'category';
  if (level === 'item') return 'item';
  switch (by ?? 'category') {
    case 'merchant':
      return 'merchant';
    case 'account':
      return 'account';
    case 'kind':
      return 'kind';
    case 'time':
      return 'weekday_hour';
    default:
      return 'top';
  }
}

/** One level deeper from a group row's key. */
export function drillInto(level: SpendLevel, by: SpendBy | undefined, key: string): Partial<InsightsSearch> {
  if (level === 'category') return { sub: key };
  if (level === 'item') return key.startsWith('n:') ? { name: key.slice(2) } : { product: key };
  switch (by ?? 'category') {
    case 'merchant':
      return { merchant: key, by: undefined };
    case 'account':
      return { account: key, by: undefined };
    case 'kind':
      return { kind: key as InsightsSearch['kind'], by: undefined };
    case 'time': {
      const [d, h] = key.split(':');
      return { weekday: d, hour: h, by: undefined };
    }
    default:
      return { cat: key };
  }
}

/** The insights_spend / v_spend_line filter for the current URL. */
export function spendFilter(s: InsightsSearch, p: Period): Record<string, string> {
  const d = periodDates(p);
  const f: Record<string, string> = { from: d.from, to: d.to };
  for (const k of FILTER_KEYS) {
    const v = s[k];
    if (v === undefined) continue;
    f[k] = k === 'recurring' ? String(v === 'yes') : String(v);
  }
  return f;
}

export interface Crumb {
  key: 'area' | (typeof FILTER_KEYS)[number];
  search: InsightsSearch;
}

/** The breadcrumb: each step removes the filters after it (the period and grouping stay). */
export function crumbs(s: InsightsSearch): Crumb[] {
  const base: InsightsSearch = { from: s.from, to: s.to, view: s.view };
  const out: Crumb[] = [{ key: 'area', search: { ...base, by: s.by } }];
  let acc: InsightsSearch = { ...base };
  for (const k of ['merchant', 'account', 'kind', 'recurring', 'weekday', 'hour', 'cat', 'sub', 'product', 'name'] as const) {
    if (s[k] === undefined) continue;
    acc = { ...acc, [k]: s[k] };
    out.push({ key: k, search: { ...acc } });
  }
  return out;
}

/** Remove undefined keys so links stay short. */
export function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** 'weekday:hour' key → [weekday 1–7, hour 0–23 | null]. */
export function parseWeekdayHour(key: string): [number, number | null] {
  const [d, h] = key.split(':');
  return [Number(d), h === undefined || h === 'none' ? null : Number(h)];
}
