// Things data access (MASTER_PLAN §3.5). Assets, tags, plans and field templates are written directly
// (RLS + column grants); anything that touches money — a service with a cost, a sale — goes through
// the RPCs of migration 37 so the ledger and the thing can't disagree.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { attachmentsQuery, type DocEntity } from '../files';
import { invalidateMoney } from '../money/queries';
import { entityPhotosQuery } from '../photos';
import { supabase } from '../supabase';
import type { Json, Tables, TablesInsert, TablesUpdate } from '../db.types';
import type { CategoryField } from './fields';

export const ASSET_STATUSES = ['in_use', 'stored', 'lent', 'in_repair', 'sold', 'disposed', 'lost'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const CONDITIONS = ['new', 'good', 'fair', 'poor', 'broken'] as const;
export type Condition = (typeof CONDITIONS)[number];
/** Statuses a person picks by hand (sold only through Sell, lent through Lend). */
export const MANUAL_STATUSES = ['in_use', 'stored', 'in_repair', 'disposed', 'lost'] as const;

export type AssetRow = Tables<'asset'>;
/** A row of `v_asset`: the asset plus names, bill, value and due dates (migration 39). */
export interface Asset extends AssetRow {
  tag: string;
  category_name: string | null;
  category_parent_id: string | null;
  category_parent_name: string | null;
  location_path: string | null;
  parent_name: string | null;
  parent_asset_no: number | null;
  parts: number;
  tag_ids: string[];
  tag_names: string[];
  bill_id: string | null;
  bill_date: string | null;
  bill_payee: string | null;
  today: string;
  months_owned: number | null;
  book_value: number | null;
  current_value: number | null;
  maintenance_cost: number;
  last_maintained_on: string | null;
  cost_of_ownership: number | null;
  cost_per_month: number | null;
  sale_gain: number | null;
  warranty_days_left: number | null;
  next_due: string | null;
}
export type PendingLine = Tables<'v_asset_pending_line'>;
export type Tag = Tables<'tag'>;
export type Plan = Tables<'v_maintenance_due'>;
export type MaintenanceLog = Tables<'maintenance_log'>;
export type Activity = Tables<'activity'>;

// Every Things query key starts with ['things', householdId] so one invalidation refreshes them all.
export const thingsKey = (householdId: string, ...rest: unknown[]) => ['things', householdId, ...rest] as const;

/** Things and Money share bills, services and sales, so both refresh together. */
export function invalidateThings(qc: QueryClient, householdId: string) {
  return Promise.all([qc.invalidateQueries({ queryKey: ['things', householdId] }), invalidateMoney(qc, householdId)]);
}

export const assetsQuery = (householdId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'assets'),
    queryFn: async (): Promise<Asset[]> => {
      const { data, error } = await supabase.from('v_asset').select('*').eq('household_id', householdId).order('name');
      if (error) throw error;
      // The view is `asset.*` plus computed columns; generated view types mark every column nullable.
      return data as unknown as Asset[];
    },
    staleTime: 30 * 1000,
  });

export const assetPhotosKey = (householdId: string) => thingsKey(householdId, 'photos');
export const assetPhotosQuery = (householdId: string) => entityPhotosQuery(householdId, 'asset', assetPhotosKey(householdId));

export const pendingLinesQuery = (householdId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'pending'),
    queryFn: async (): Promise<PendingLine[]> => {
      const { data, error } = await supabase
        .from('v_asset_pending_line')
        .select('*')
        .eq('household_id', householdId)
        .order('occurred_on', { ascending: false })
        .order('line_no');
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

export const tagsQuery = (householdId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'tags'),
    queryFn: async (): Promise<Tag[]> => {
      const { data, error } = await supabase.from('tag').select('*').eq('household_id', householdId).order('name');
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

export const fieldsQuery = (householdId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'fields'),
    queryFn: async (): Promise<CategoryField[]> => {
      const { data, error } = await supabase
        .from('category_field')
        .select('id, category_id, key, label, type, options, sort')
        .eq('household_id', householdId);
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

/** Active and paused plans with their thing; all of them, or one thing's. */
export const plansQuery = (householdId: string, assetId?: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'plans', assetId ?? 'all'),
    queryFn: async (): Promise<Plan[]> => {
      let q = supabase.from('v_maintenance_due').select('*').eq('household_id', householdId);
      if (assetId) q = q.eq('asset_id', assetId);
      const { data, error } = await q.order('next_due', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

export const logsQuery = (householdId: string, assetId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'logs', assetId),
    queryFn: async (): Promise<MaintenanceLog[]> => {
      const { data, error } = await supabase
        .from('maintenance_log')
        .select('*')
        .eq('household_id', householdId)
        .eq('asset_id', assetId)
        .order('done_on', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

export const activityQuery = (householdId: string, assetId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'activity', assetId),
    queryFn: async (): Promise<Activity[]> => {
      const { data, error } = await supabase
        .from('activity')
        .select('*')
        .eq('household_id', householdId)
        .eq('entity_type', 'asset')
        .eq('entity_id', assetId)
        .order('at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

/** Documents of one entity (things, bills or service logs). */
export const docsQuery = (householdId: string, entityType: DocEntity, entityIds: string[]) =>
  attachmentsQuery(householdId, entityType, entityIds, thingsKey(householdId, 'docs', entityType, [...entityIds].sort().join(',')));

/** Recent expenses a service could have been paid by (to link instead of logging it twice). */
export const recentExpensesQuery = (householdId: string, from: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'recent-expenses', from),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('money_transaction')
        .select('id, occurred_on, payee_text, total, source')
        .eq('household_id', householdId)
        .eq('type', 'expense')
        .gte('occurred_on', from)
        .order('occurred_on', { ascending: false })
        .limit(60);
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

// ── Writes ────────────────────────────────────────────────────────────────────

export type AssetInput = Pick<
  TablesInsert<'asset'>,
  | 'name' | 'description' | 'category_id' | 'location_id' | 'parent_id' | 'quantity' | 'manufacturer' | 'model_no'
  | 'serial_no' | 'condition' | 'status' | 'lent_to' | 'lent_on' | 'transaction_line_id' | 'purchase_price'
  | 'purchased_on' | 'vendor' | 'useful_life_months' | 'salvage_value' | 'warranty_until' | 'lifetime_warranty'
  | 'warranty_notes' | 'insured' | 'insurance_notes' | 'custom'
>;

/** `id` is chosen here so the photo can be uploaded under the new thing's folder; code/A-number come from the DB. */
export async function createAsset(householdId: string, input: AssetInput, id: string = crypto.randomUUID()): Promise<AssetRow> {
  const row = { ...input, id, household_id: householdId } as TablesInsert<'asset'>;
  const { data, error } = await supabase.from('asset').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function updateAsset(id: string, patch: Partial<AssetInput> & { archived?: boolean }): Promise<AssetRow> {
  const { data, error } = await supabase
    .from('asset')
    .update(patch as TablesUpdate<'asset'>)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAsset(id: string) {
  const { error } = await supabase.from('asset').delete().eq('id', id);
  if (error) throw error;
}

/** Move a thing (and, when asked, its parts) to a place. */
export async function moveAssets(ids: string[], locationId: string | null) {
  const { error } = await supabase.from('asset').update({ location_id: locationId }).in('id', ids);
  if (error) throw error;
}

export async function createTag(householdId: string, name: string): Promise<Tag> {
  const { data, error } = await supabase.from('tag').insert({ household_id: householdId, name: name.trim() }).select('*').single();
  if (error) throw error;
  return data;
}

export async function deleteTag(id: string) {
  const { error } = await supabase.from('tag').delete().eq('id', id);
  if (error) throw error;
}

/** Make a thing's tags exactly `want`. */
export async function setAssetTags(householdId: string, assetId: string, want: string[], have: string[]) {
  const add = want.filter((t) => !have.includes(t));
  const drop = have.filter((t) => !want.includes(t));
  if (drop.length) {
    const { error } = await supabase.from('asset_tag').delete().eq('asset_id', assetId).in('tag_id', drop);
    if (error) throw error;
  }
  if (add.length) {
    const { error } = await supabase
      .from('asset_tag')
      .insert(add.map((tag_id) => ({ household_id: householdId, asset_id: assetId, tag_id })));
    if (error) throw error;
  }
}

export interface PlanInput {
  name: string;
  category_id: string | null;
  every_days: number | null;
  every_usage: number | null;
  usage_unit: string | null;
  next_due: string | null;
  notify_days_before: number;
  active: boolean;
  notes: string | null;
}

export async function savePlan(householdId: string, assetId: string, input: PlanInput, id?: string) {
  const { error } = id
    ? await supabase.from('maintenance_plan').update(input).eq('id', id)
    : await supabase.from('maintenance_plan').insert({ ...input, household_id: householdId, asset_id: assetId });
  if (error) throw error;
}

export async function deletePlan(id: string) {
  const { error } = await supabase.from('maintenance_plan').delete().eq('id', id);
  if (error) throw error;
}

export interface LogInput {
  asset_id: string;
  plan_id?: string | null;
  done_on: string;
  title: string;
  notes?: string | null;
  vendor?: string | null;
  usage_reading?: number | null;
  cost?: number | null;
  /** Create the ledger expense … */
  expense?: { account_id: string; category_id: string; fingerprint: string; line_fingerprint: string };
  /** … or link one that is already in Money. */
  link_transaction_id?: string;
}

const clean = (p: object) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));

export async function logMaintenance(p: LogInput): Promise<{ id: string; transaction_id: string | null }> {
  const { data, error } = await supabase.rpc('rpc_log_maintenance', { p: clean(p) as Json });
  if (error) throw error;
  return data as { id: string; transaction_id: string | null };
}

export async function updateLog(id: string, patch: Partial<Pick<MaintenanceLog, 'title' | 'notes' | 'vendor' | 'done_on' | 'usage_reading'>>) {
  const { error } = await supabase.from('maintenance_log').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteLog(id: string, deleteExpense: boolean) {
  const { error } = await supabase.rpc('rpc_delete_maintenance_log', { p_id: id, p_delete_expense: deleteExpense });
  if (error) throw error;
}

export interface SellInput {
  asset_id: string;
  sold_on: string;
  sold_to?: string | null;
  price: number;
  account_id: string;
  category_id: string;
  fingerprint: string;
  line_fingerprint: string;
  include_parts?: boolean;
}

export async function sellAsset(p: SellInput): Promise<{ transaction_id: string }> {
  const { data, error } = await supabase.rpc('rpc_asset_sell', { p: clean(p) as Json });
  if (error) throw error;
  return data as { transaction_id: string };
}

export async function unsellAsset(id: string) {
  const { error } = await supabase.rpc('rpc_asset_unsell', { p_asset: id });
  if (error) throw error;
}

export async function splitAsset(id: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('rpc_asset_split', { p_asset: id });
  if (error) throw error;
  return data ?? [];
}

/** "Not a thing": the bill lines become expense only (grouped per bill, one call each); Undo sends them back. */
export async function markNotThings(lines: Array<Pick<PendingLine, 'line_id' | 'transaction_id'>>, destiny: 'expense' | 'asset' = 'expense') {
  const byTx = new Map<string, string[]>();
  for (const l of lines) {
    if (!l.line_id || !l.transaction_id) continue;
    byTx.set(l.transaction_id, [...(byTx.get(l.transaction_id) ?? []), l.line_id]);
  }
  for (const [tx, ids] of byTx) {
    const { error } = await supabase.rpc('rpc_route_lines', {
      p_transaction: tx,
      p_routes: ids.map((line_id) => ({ line_id, destiny, learn: false })) as unknown as Json,
    });
    if (error) throw error;
  }
}

export async function createField(
  householdId: string,
  input: Pick<CategoryField, 'category_id' | 'key' | 'label' | 'type' | 'options' | 'sort'>,
) {
  const { error } = await supabase.from('category_field').insert({ ...input, household_id: householdId });
  if (error) throw error;
}

export async function updateField(id: string, patch: Partial<Pick<CategoryField, 'label' | 'options' | 'sort'>>) {
  const { error } = await supabase.from('category_field').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteField(id: string) {
  const { error } = await supabase.from('category_field').delete().eq('id', id);
  if (error) throw error;
}

/** Settings › Storage (§7e). */
export const storageUsageQuery = (householdId: string) =>
  queryOptions({
    queryKey: thingsKey(householdId, 'storage'),
    queryFn: async () => {
      const { data, error } = await supabase.from('v_storage_usage').select('*').eq('household_id', householdId);
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

// ── Errors ────────────────────────────────────────────────────────────────────

export type ThingsError =
  | 'notThingLine' | 'sold' | 'routed' | 'duplicate' | 'reference' | 'invalid' | 'denied' | 'nameTaken' | 'generic';

/** Postgres / RPC error → i18n key suffix under things.errors. */
export function thingsErrorKey(e: unknown): ThingsError {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDLIN') return 'notThingLine';
  if (code === 'GDSLD') return 'sold';
  if (code === 'GDRTD') return 'routed';
  if (code === 'GDDUP') return 'duplicate';
  if (code === '23505') return 'nameTaken';
  if (code === '23503') return 'reference';
  if (code === '23514') return 'invalid';
  if (code === '42501') return 'denied';
  return 'generic';
}
