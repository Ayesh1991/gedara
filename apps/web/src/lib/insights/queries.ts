// Insights, Attention, budgets and the activity timeline (Phase 6). Reads go to security_invoker
// views / functions (the caller's RLS). Budgets and hidden attention items are plain table writes.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import type { AttentionItem } from '../attention';
import { moneyKey } from '../money/queries';

export const insightsKey = (householdId: string, ...rest: unknown[]) => ['insights', householdId, ...rest] as const;
export const attentionKey = (householdId: string) => ['attention', householdId] as const;
export const activityKey = (householdId: string) => ['activity', householdId] as const;

/** Anything that changes money, stock or things can change insights and attention. */
export function invalidateInsights(qc: QueryClient, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: insightsKey(householdId) }),
    qc.invalidateQueries({ queryKey: attentionKey(householdId) }),
    qc.invalidateQueries({ queryKey: activityKey(householdId) }),
  ]);
}

/** PostgREST returns ≤ 1000 rows per request: page through a view. */
async function selectAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

// ── Spend ─────────────────────────────────────────────────────────────────────

export interface SpendGroup {
  key: string;
  label: string | null;
  amount: number;
  lines: number;
  bills: number;
  first_on: string | null;
  last_on: string | null;
}

export const spendGroupsQuery = (householdId: string, filter: Record<string, string>, by: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'spend', by, filter),
    queryFn: async (): Promise<SpendGroup[]> => {
      const { data, error } = await supabase.rpc('insights_spend', { p_household: householdId, p: { ...filter, by } });
      if (error) throw error;
      return (data ?? []) as SpendGroup[];
    },
    staleTime: 30 * 1000,
  });

export interface SpendLine {
  line_id: string;
  transaction_id: string;
  raw_name: string;
  occurred_on: string;
  amount: number;
  qty: number | null;
  unit_text: string | null;
  price_per_base: number | null;
  merchant_name: string | null;
  account_name: string | null;
  category_name: string | null;
  product_name: string | null;
  type: string;
}

/** The record level: the bill lines behind a number, newest first. */
export const spendLinesQuery = (householdId: string, filter: Record<string, string>, limit = 200) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'lines', filter, limit),
    queryFn: async (): Promise<SpendLine[]> => {
      let q = supabase
        .from('v_spend_line')
        .select(
          'line_id, transaction_id, raw_name, occurred_on, amount, qty, unit_text, price_per_base, merchant_name, account_name, category_name, product_name, type, top_category_id, category_id',
        )
        .eq('household_id', householdId);
      if (filter.from) q = q.gte('occurred_on', filter.from);
      if (filter.to) q = q.lte('occurred_on', filter.to);
      const none = (col: 'top_category_id' | 'category_id' | 'merchant_id', v: string) => (v === 'none' ? q.is(col, null) : q.eq(col, v));
      if (filter.cat) q = none('top_category_id', filter.cat);
      if (filter.sub) q = none('category_id', filter.sub);
      if (filter.merchant) q = none('merchant_id', filter.merchant);
      if (filter.product) q = q.eq('product_id', filter.product);
      if (filter.name) q = q.is('product_id', null).ilike('raw_name', filter.name.replace(/[%_\\]/g, '\\$&'));
      if (filter.account) q = q.eq('account_id', filter.account);
      if (filter.kind) q = q.eq('account_kind', filter.kind);
      if (filter.recurring) q = filter.recurring === 'true' ? q.not('recurring_id', 'is', null) : q.is('recurring_id', null);
      if (filter.weekday) q = q.eq('weekday', Number(filter.weekday));
      if (filter.hour) q = filter.hour === 'none' ? q.is('hour', null) : q.eq('hour', Number(filter.hour));
      const { data, error } = await q.order('occurred_on', { ascending: false }).order('line_id').limit(limit);
      if (error) throw error;
      return data as unknown as SpendLine[];
    },
    staleTime: 30 * 1000,
  });

// ── Cash flow ─────────────────────────────────────────────────────────────────

export interface MonthEnd {
  account_id: string;
  account_name: string;
  kind: string;
  month: string; // 'YYYY-MM'
  balance: number;
}

export const monthEndQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'month-end'),
    queryFn: async (): Promise<MonthEnd[]> => {
      const rows = await selectAll((from, to) =>
        supabase
          .from('v_account_month_end')
          .select('account_id, account_name, kind, month, balance')
          .eq('household_id', householdId)
          .order('month')
          .range(from, to),
      );
      return rows.map((r) => ({
        account_id: r.account_id ?? '',
        account_name: r.account_name ?? '',
        kind: r.kind ?? '',
        month: (r.month ?? '').slice(0, 7),
        balance: r.balance ?? 0,
      }));
    },
    staleTime: 60 * 1000,
  });

export interface BudgetRowStatus {
  category_id: string;
  name: string;
  budget: number | null;
  budget_from: string | null;
  spent: number;
  lines: number;
}

export const budgetMonthQuery = (householdId: string, month: string) =>
  queryOptions({
    queryKey: [...moneyKey(householdId, 'budget-month', month)],
    queryFn: async (): Promise<BudgetRowStatus[]> => {
      const { data, error } = await supabase.rpc('budget_month', { p_household: householdId, p_month: `${month}-01` });
      if (error) throw error;
      return (data ?? []) as BudgetRowStatus[];
    },
    staleTime: 30 * 1000,
  });

export interface BudgetRow {
  id: string;
  category_id: string;
  month: string;
  amount: number;
}

export const budgetsQuery = (householdId: string) =>
  queryOptions({
    queryKey: [...moneyKey(householdId, 'budgets')],
    queryFn: async (): Promise<BudgetRow[]> => {
      const { data, error } = await supabase
        .from('budget')
        .select('id, category_id, month, amount')
        .eq('household_id', householdId)
        .order('month');
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

/** Sets a main category's budget from `month` on ('YYYY-MM'); 0 = no budget from then. */
export async function setBudget(householdId: string, categoryId: string, month: string, amount: number) {
  const day = `${month}-01`;
  const { data: existing, error: readErr } = await supabase
    .from('budget')
    .select('id')
    .eq('household_id', householdId)
    .eq('category_id', categoryId)
    .eq('month', day)
    .maybeSingle();
  if (readErr) throw readErr;
  const { error } = existing
    ? await supabase.from('budget').update({ amount }).eq('id', existing.id)
    : await supabase.from('budget').insert({ household_id: householdId, category_id: categoryId, month: day, amount });
  if (error) throw error;
}

// ── Prices, pantry, utilities, places ─────────────────────────────────────────

export interface PriceMonth {
  product_id: string;
  product_name: string;
  category_id: string | null;
  month: string;
  merchant_id: string | null;
  merchant_name: string | null;
  qty: number;
  spent: number;
  unit_cost: number;
  unit_code: string;
}

export const priceMonthQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'prices'),
    queryFn: async (): Promise<PriceMonth[]> => {
      const rows = await selectAll((from, to) =>
        supabase
          .from('v_product_price_month')
          .select('product_id, product_name, category_id, month, merchant_id, merchant_name, qty, spent, unit_cost, unit_code')
          .eq('household_id', householdId)
          .order('month')
          .range(from, to),
      );
      return rows.map((r) => ({ ...r, month: (r.month ?? '').slice(0, 7) }) as PriceMonth);
    },
    staleTime: 60 * 1000,
  });

export interface StockFlow {
  product_id: string;
  product_name: string;
  category_id: string | null;
  top_category_id: string | null;
  month: string;
  flow: 'bought' | 'consumed' | 'wasted';
  qty: number;
  value: number;
  movements: number;
  unit_code: string;
}

export const stockFlowQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'stock-flow'),
    queryFn: async (): Promise<StockFlow[]> => {
      const rows = await selectAll((from, to) =>
        supabase
          .from('v_stock_flow_month')
          .select('product_id, product_name, category_id, top_category_id, month, flow, qty, value, movements, unit_code')
          .eq('household_id', householdId)
          .order('month')
          .range(from, to),
      );
      return rows.map((r) => ({ ...r, month: (r.month ?? '').slice(0, 7) }) as StockFlow);
    },
    staleTime: 60 * 1000,
  });

export interface Velocity {
  product_id: string;
  product_name: string;
  qty: number;
  qty_effective: number;
  below_min: boolean;
  unit_code: string;
  used_30: number;
  used_90: number;
  per_day: number | null;
  days_to_empty: number | null;
  last_used_on: string | null;
}

export const velocityQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'velocity'),
    queryFn: async (): Promise<Velocity[]> => {
      const { data, error } = await supabase
        .from('v_product_velocity')
        .select('product_id, product_name, qty, qty_effective, below_min, unit_code, used_30, used_90, per_day, days_to_empty, last_used_on')
        .eq('household_id', householdId)
        .order('days_to_empty', { nullsFirst: false });
      if (error) throw error;
      return data as unknown as Velocity[];
    },
    staleTime: 60 * 1000,
  });

export interface UtilityUsage {
  recurring_id: string;
  rule_name: string;
  usage_unit: string | null;
  transaction_id: string;
  period: string | null;
  occurred_on: string;
  amount: number;
  units: number | null;
  per_unit: number | null;
}

export const utilityQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'utilities'),
    queryFn: async (): Promise<UtilityUsage[]> => {
      const { data, error } = await supabase
        .from('v_utility_usage')
        .select('recurring_id, rule_name, usage_unit, transaction_id, period, occurred_on, amount, units, per_unit')
        .eq('household_id', householdId)
        .order('occurred_on');
      if (error) throw error;
      return data as unknown as UtilityUsage[];
    },
    staleTime: 60 * 1000,
  });

export interface LocationContents {
  location_id: string;
  name: string;
  path: string;
  parent_id: string | null;
  lots: number;
  products: number;
  stock_value: number;
  assets: number;
  asset_value: number;
  last_touched: string | null;
  stale_lots: number;
  stale_assets: number;
}

export const locationContentsQuery = (householdId: string) =>
  queryOptions({
    queryKey: insightsKey(householdId, 'places'),
    queryFn: async (): Promise<LocationContents[]> => {
      const { data, error } = await supabase
        .from('v_location_contents')
        .select('location_id, name, path, parent_id, lots, products, stock_value, assets, asset_value, last_touched, stale_lots, stale_assets')
        .eq('household_id', householdId)
        .order('path');
      if (error) throw error;
      return data as unknown as LocationContents[];
    },
    staleTime: 60 * 1000,
  });

// ── Attention ─────────────────────────────────────────────────────────────────

export const attentionQuery = (householdId: string) =>
  queryOptions({
    queryKey: attentionKey(householdId),
    queryFn: async (): Promise<AttentionItem[]> => {
      const { data, error } = await supabase.rpc('attention_feed', { p_household: householdId });
      if (error) throw error;
      return (data ?? []) as unknown as AttentionItem[];
    },
    staleTime: 15 * 1000,
  });

/** Hide an item (null = until it changes). Insert, or move the date of an earlier hide. */
export async function hideAttention(householdId: string, itemKey: string, hiddenUntil: string | null) {
  const { error } = await supabase
    .from('attention_dismissal')
    .insert({ household_id: householdId, item_key: itemKey, hidden_until: hiddenUntil });
  if (error?.code === '23505') {
    const { error: upd } = await supabase
      .from('attention_dismissal')
      .update({ hidden_until: hiddenUntil })
      .eq('household_id', householdId)
      .eq('item_key', itemKey);
    if (upd) throw upd;
    return;
  }
  if (error) throw error;
}

export async function unhideAttention(householdId: string, itemKey: string) {
  const { error } = await supabase.from('attention_dismissal').delete().eq('household_id', householdId).eq('item_key', itemKey);
  if (error) throw error;
}

// ── Activity ──────────────────────────────────────────────────────────────────

export interface ActivityRow {
  id: number;
  at: string;
  actor_name: string | null;
  entity_type: string;
  entity_id: string;
  verb: string;
  summary: string | null;
  payload: Record<string, unknown>;
}

export const activityQuery = (householdId: string, limit = 8) =>
  queryOptions({
    queryKey: [...activityKey(householdId), limit],
    queryFn: async (): Promise<ActivityRow[]> => {
      const { data, error } = await supabase
        .from('v_activity')
        .select('id, at, actor_name, entity_type, entity_id, verb, summary, payload')
        .eq('household_id', householdId)
        .order('at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as unknown as ActivityRow[];
    },
    staleTime: 15 * 1000,
  });

// ── Push (Settings › Notifications, Diagnostics) ──────────────────────────────

export interface MyDevice {
  id: string;
  endpoint: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export const myDevicesQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['push-devices', householdId],
    queryFn: async (): Promise<MyDevice[]> => {
      const { data, error } = await supabase
        .from('push_subscription')
        .select('id, endpoint, label, enabled, created_at, last_ok_at, last_error')
        .eq('household_id', householdId)
        .order('created_at');
      if (error) throw error;
      return data;
    },
    staleTime: 15 * 1000,
  });

export interface PushStatus {
  scheduled: boolean;
  project_url_set: boolean;
  last_job: { status: string; at: string; message: string | null } | null;
  last_run: { run_on: string; items: number; sent: number; failed: number; finished_at: string | null } | null;
}

export const pushStatusQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['push-status', householdId],
    queryFn: async (): Promise<PushStatus> => {
      const { data, error } = await supabase.rpc('attention_push_status', { p_household: householdId });
      if (error) throw error;
      return data as unknown as PushStatus;
    },
    staleTime: 30 * 1000,
  });
