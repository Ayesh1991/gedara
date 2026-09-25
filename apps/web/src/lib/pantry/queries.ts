// Pantry data access. Reads go to the tables/views (RLS). Products, barcodes, conversions and
// household units are written directly (RLS + column grants); stock only ever changes through the
// RPCs of migration 26 (CLAUDE.md rule 1).
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { entityPhotosQuery } from '../photos';
import type { Json, Tables, TablesInsert, TablesUpdate } from '../db.types';
import type { Conversion, Unit, UnitMap } from './units';

export const DUE_TYPES = ['none', 'best_before', 'expiry'] as const;
export type DueTypeValue = (typeof DUE_TYPES)[number];

export type ProductRow = Tables<'product'>;
export interface ProductStock {
  qty: number;
  qtyOpened: number;
  qtyEffective: number;
  nextDue: string | null;
  value: number;
  lots: number;
  unpricedQty: number;
  belowMin: boolean;
  lastUnitCost: number | null;
}
export interface Product extends ProductRow {
  stock: ProductStock;
}
export type Lot = Tables<'stock_lot'>;
export type Barcode = Tables<'product_barcode'>;
export type ConversionRow = Tables<'product_unit_conversion'>;
export type JournalRow = Tables<'v_stock_journal'>;

// Every pantry query key starts with ['pantry', householdId] so one invalidation refreshes them all.
export const pantryKey = (householdId: string, ...rest: unknown[]) => ['pantry', householdId, ...rest] as const;

export function invalidatePantry(qc: QueryClient, householdId: string) {
  return qc.invalidateQueries({ queryKey: ['pantry', householdId] });
}

const EMPTY_STOCK: ProductStock = {
  qty: 0,
  qtyOpened: 0,
  qtyEffective: 0,
  nextDue: null,
  value: 0,
  lots: 0,
  unpricedQty: 0,
  belowMin: false,
  lastUnitCost: null,
};

/** System units + the household's own. */
export const pantryUnitsQuery = (householdId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'units'),
    queryFn: async (): Promise<UnitMap> => {
      const { data, error } = await supabase.from('unit').select('id, household_id, code, name, dimension, to_base, aliases');
      if (error) throw error;
      return new Map(data.map((u) => [u.id, u satisfies Unit]));
    },
    staleTime: 10 * 60 * 1000,
  });

export const productsQuery = (householdId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'products'),
    queryFn: async (): Promise<Product[]> => {
      const [products, stock] = await Promise.all([
        supabase.from('product').select('*').eq('household_id', householdId).order('name'),
        supabase.from('v_product_stock').select('*').eq('household_id', householdId),
      ]);
      if (products.error) throw products.error;
      if (stock.error) throw stock.error;
      const byId = new Map(stock.data.map((s) => [s.product_id, s]));
      return products.data.map((p) => {
        const s = byId.get(p.id);
        return {
          ...p,
          stock: s
            ? {
                qty: s.qty ?? 0,
                qtyOpened: s.qty_opened ?? 0,
                qtyEffective: s.qty_effective ?? 0,
                nextDue: s.next_due,
                value: s.value ?? 0,
                lots: s.lots ?? 0,
                unpricedQty: s.unpriced_qty ?? 0,
                belowMin: s.below_min ?? false,
                lastUnitCost: s.last_unit_cost,
              }
            : EMPTY_STOCK,
        };
      });
    },
    staleTime: 30 * 1000,
  });

export const conversionsQuery = (householdId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'conversions'),
    queryFn: async (): Promise<Conversion[]> => {
      const { data, error } = await supabase
        .from('product_unit_conversion')
        .select('product_id, from_unit_id, to_unit_id, factor')
        .eq('household_id', householdId);
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

export const barcodesQuery = (householdId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'barcodes'),
    queryFn: async (): Promise<Barcode[]> => {
      const { data, error } = await supabase.from('product_barcode').select('*').eq('household_id', householdId);
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

/** Lots with stock, FEFO order (the order the database uses them in). */
export function fefo(a: Lot, b: Lot): number {
  const ao = a.opened_at ? 0 : 1;
  const bo = b.opened_at ? 0 : 1;
  if (ao !== bo) return ao - bo;
  const ad = a.due_date ?? '9999-12-31';
  const bd = b.due_date ?? '9999-12-31';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ap = a.purchased_on ?? '9999-12-31';
  const bp = b.purchased_on ?? '9999-12-31';
  if (ap !== bp) return ap < bp ? -1 : 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

export const productLotsQuery = (householdId: string, productId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'lots', productId),
    queryFn: async (): Promise<Lot[]> => {
      const { data, error } = await supabase
        .from('stock_lot')
        .select('*')
        .eq('household_id', householdId)
        .eq('product_id', productId)
        .gt('qty_remaining', 0);
      if (error) throw error;
      return data.sort(fefo);
    },
    staleTime: 15 * 1000,
  });

export const placeLotsQuery = (householdId: string, placeId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'place-lots', placeId),
    queryFn: async (): Promise<Lot[]> => {
      const { data, error } = await supabase
        .from('stock_lot')
        .select('*')
        .eq('household_id', householdId)
        .eq('location_id', placeId)
        .gt('qty_remaining', 0);
      if (error) throw error;
      return data.sort(fefo);
    },
    staleTime: 15 * 1000,
  });

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Insights' record level: one reason, and a household-local date range ('YYYY-MM-DD', inclusive). */
export interface JournalFilter {
  reason?: 'purchase' | 'consume' | 'waste';
  from?: string;
  to?: string;
}

export const journalQuery = (householdId: string, productId?: string, limit = 80, filter: JournalFilter = {}) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'journal', productId ?? 'all', limit, filter),
    queryFn: async (): Promise<JournalRow[]> => {
      let q = supabase.from('v_stock_journal').select('*').eq('household_id', householdId);
      if (productId) q = q.eq('product_id', productId);
      if (filter.reason) q = q.eq('reason', filter.reason);
      // Sri Lanka is UTC+05:30 all year: local midnight → an exact instant.
      if (filter.from) q = q.gte('created_at', `${filter.from}T00:00:00+05:30`);
      if (filter.to) q = q.lt('created_at', `${nextDay(filter.to)}T00:00:00+05:30`);
      const { data, error } = await q.order('seq', { ascending: false }).limit(limit);
      if (error) throw error;
      return data;
    },
    staleTime: 15 * 1000,
  });

export const productPhotosKey = (householdId: string) => pantryKey(householdId, 'photos');
export const productPhotosQuery = (householdId: string) =>
  entityPhotosQuery(householdId, 'product', productPhotosKey(householdId));

// ── Stock RPCs ────────────────────────────────────────────────────────────────

export interface StockResult {
  correlation_id: string | null;
  lot_id?: string;
  qty?: number;
  cost?: number;
  lots?: number;
  delta?: number;
}

type RpcName = 'rpc_purchase' | 'rpc_consume' | 'rpc_open' | 'rpc_transfer' | 'rpc_inventory' | 'rpc_set_lot_due';

async function stockRpc(name: RpcName, p: Record<string, unknown>): Promise<StockResult> {
  // Drop undefined keys: the RPCs treat a present key (even null) as "given".
  const body = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  const { data, error } = await supabase.rpc(name, { p: body as Json });
  if (error) throw error;
  const r = data as Record<string, unknown>;
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  return {
    correlation_id: (r.correlation_id as string | null) ?? null,
    lot_id: (r.lot_id as string | undefined) ?? undefined,
    qty: num(r.qty),
    cost: num(r.cost),
    lots: num(r.lots),
    delta: num(r.delta),
  };
}

interface Base {
  household_id: string;
}
export interface PurchaseInput extends Base {
  product_id: string;
  qty: number;
  unit_id?: string | null;
  location_id?: string | null;
  total_cost?: number | null;
  purchased_on?: string;
  /** Omit for the product's default; null for "no date". */
  due_date?: string | null;
  note?: string | null;
}
export interface ConsumeInput extends Base {
  product_id: string;
  qty?: number;
  unit_id?: string | null;
  all?: boolean;
  location_id?: string | null;
  lot_id?: string | null;
  reason?: 'consume' | 'waste';
  note?: string | null;
}
export interface OpenInput extends Base {
  lot_id?: string;
  product_id?: string;
  location_id?: string;
  qty?: number;
  unit_id?: string | null;
}
export interface TransferInput extends Base {
  to_location_id: string;
  lot_id?: string;
  product_id?: string;
  from_location_id?: string | null;
  qty?: number;
  unit_id?: string | null;
}
export interface InventoryInput extends Base {
  product_id: string;
  qty: number;
  unit_id?: string | null;
  location_id?: string | null;
  due_date?: string | null;
  note?: string | null;
}

export const purchase = (p: PurchaseInput) => stockRpc('rpc_purchase', { ...p });
export const consume = (p: ConsumeInput) => stockRpc('rpc_consume', { ...p });
export const openStock = (p: OpenInput) => stockRpc('rpc_open', { ...p });
export const transfer = (p: TransferInput) => stockRpc('rpc_transfer', { ...p });
export const inventory = (p: InventoryInput) => stockRpc('rpc_inventory', { ...p });
export const setLotDue = (p: Base & { lot_id: string; due_date: string | null }) => stockRpc('rpc_set_lot_due', { ...p });

export async function undoStock(correlationId: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_undo', { p_correlation: correlationId });
  if (error) throw error;
}

// ── Products, barcodes, conversions, units ───────────────────────────────────

export type ProductInput = Pick<
  TablesInsert<'product'>,
  | 'name' | 'name_si' | 'parent_id' | 'category_id' | 'stock_unit_id' | 'purchase_unit_id' | 'min_qty'
  | 'default_location_id' | 'due_type' | 'default_due_days' | 'due_days_after_open' | 'due_days_frozen'
  | 'quick_consume_qty' | 'treat_opened_as_out' | 'notes'
>;

export async function createProduct(householdId: string, input: ProductInput): Promise<ProductRow> {
  // `code` is set by a database trigger; clients have no privilege to write it.
  const row = { ...input, id: crypto.randomUUID(), household_id: householdId } as TablesInsert<'product'>;
  const { data, error } = await supabase.from('product').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function updateProduct(id: string, patch: Partial<ProductInput> & { archived?: boolean }): Promise<ProductRow> {
  const { data, error } = await supabase
    .from('product')
    .update(patch as TablesUpdate<'product'>)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('product').delete().eq('id', id);
  if (error) throw error;
}

export async function addBarcode(householdId: string, productId: string, barcode: string, unitId: string | null, qty: number) {
  const { error } = await supabase
    .from('product_barcode')
    .insert({ household_id: householdId, product_id: productId, barcode: barcode.trim(), unit_id: unitId, qty });
  if (error) throw error;
}

export async function removeBarcode(id: string) {
  const { error } = await supabase.from('product_barcode').delete().eq('id', id);
  if (error) throw error;
}

/** "1 <from> = factor × <to>" for a product, replacing any earlier one for the same unit. */
export async function saveConversion(householdId: string, productId: string, fromUnitId: string, toUnitId: string, factor: number) {
  const del = await supabase.from('product_unit_conversion').delete().eq('product_id', productId).eq('from_unit_id', fromUnitId);
  if (del.error) throw del.error;
  const { error } = await supabase.from('product_unit_conversion').insert({
    household_id: householdId,
    product_id: productId,
    from_unit_id: fromUnitId,
    to_unit_id: toUnitId,
    factor,
  });
  if (error) throw error;
}

export async function removeConversion(productId: string, fromUnitId: string) {
  const { error } = await supabase.from('product_unit_conversion').delete().eq('product_id', productId).eq('from_unit_id', fromUnitId);
  if (error) throw error;
}

export async function createUnit(
  householdId: string,
  input: { code: string; name: string; dimension: string; to_base: number; aliases: string[] },
) {
  const { error } = await supabase.from('unit').insert({ household_id: householdId, ...input });
  if (error) throw error;
}

export async function deleteUnit(id: string) {
  const { error } = await supabase.from('unit').delete().eq('id', id);
  if (error) throw error;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type PantryError =
  | 'noStock' | 'unitMismatch' | 'cantUndo' | 'unitLocked' | 'duplicate' | 'reference' | 'invalid' | 'denied' | 'generic';

/** Postgres / RPC error → i18n key suffix under pantry.errors. */
export function pantryErrorKey(e: unknown): PantryError {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDSTK') return 'noStock';
  if (code === 'GDUNT') return 'unitMismatch';
  if (code === 'GDUND') return 'cantUndo';
  if (code === 'GDUNL') return 'unitLocked';
  if (code === '23505') return 'duplicate';
  if (code === '23503') return 'reference';
  if (code === '23514') return 'invalid';
  if (code === '42501') return 'denied';
  return 'generic';
}

/** For GDSTK: how much there actually is (stock units), from the error's DETAIL. */
export function availableQty(e: unknown): number | null {
  const d = (e as { details?: string } | null)?.details;
  const n = d === undefined ? NaN : Number(d);
  return Number.isFinite(n) ? n : null;
}
