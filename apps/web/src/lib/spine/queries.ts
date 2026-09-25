// Data access for the spine (Phase 4): learned bill names, where bill lines went, prices by shop,
// routing an existing bill, and the shopping list. List items are written directly (RLS + column
// grants); routing and ticking-by-bill only happen in the RPCs of migration 31.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import type { Json, Tables } from '../db.types';
import { pantryKey } from '../pantry/queries';
import type { RpcRoute } from './route';

export type AliasRow = Tables<'product_alias'>;
export type LineRouteRow = Tables<'v_line_route'>;
export type ProductPrice = Tables<'v_product_price'>;
export type ListItem = Tables<'v_shopping_list'>;

export const aliasesQuery = (householdId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'aliases'),
    queryFn: async (): Promise<AliasRow[]> => {
      const { data, error } = await supabase.from('product_alias').select('*').eq('household_id', householdId);
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

export async function forgetAlias(id: string) {
  const { error } = await supabase.from('product_alias').delete().eq('id', id);
  if (error) throw error;
}

export const lineRoutesQuery = (householdId: string, transactionId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'line-routes', transactionId),
    queryFn: async (): Promise<Map<string, LineRouteRow>> => {
      const { data, error } = await supabase
        .from('v_line_route')
        .select('*')
        .eq('household_id', householdId)
        .eq('transaction_id', transactionId);
      if (error) throw error;
      return new Map(data.map((r) => [r.line_id!, r]));
    },
    staleTime: 15 * 1000,
  });

export const productPricesQuery = (householdId: string, productId: string) =>
  queryOptions({
    queryKey: pantryKey(householdId, 'prices', productId),
    queryFn: async (): Promise<ProductPrice[]> => {
      const { data, error } = await supabase
        .from('v_product_price')
        .select('*')
        .eq('household_id', householdId)
        .eq('product_id', productId)
        .order('last_bought_on', { ascending: false });
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

export interface RouteLinesResult {
  lots: number;
  ticked: number;
  correlation_id: string | null;
}

/** "Send to pantry" on a bill that's already in Gedara. */
export async function routeLines(
  transactionId: string,
  routes: Array<RpcRoute & { line_id: string }>,
  tick: string[] = [],
): Promise<RouteLinesResult> {
  const { data, error } = await supabase.rpc('rpc_route_lines', {
    p_transaction: transactionId,
    p_routes: routes as unknown as Json,
    p_tick: tick as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as RouteLinesResult;
}

// ── Shopping list ─────────────────────────────────────────────────────────────

export const shoppingKey = (householdId: string) => ['shopping', householdId] as const;

export function invalidateShopping(qc: QueryClient, householdId: string) {
  return qc.invalidateQueries({ queryKey: shoppingKey(householdId) });
}

export const shoppingListQuery = (householdId: string) =>
  queryOptions({
    queryKey: shoppingKey(householdId),
    queryFn: async (): Promise<ListItem[]> => {
      const { data, error } = await supabase
        .from('v_shopping_list')
        .select('*')
        .eq('household_id', householdId)
        .eq('list', 'Main')
        .order('created_at');
      if (error) throw error;
      return data;
    },
    staleTime: 15 * 1000,
  });

/** Adds below-minimum products / removes ones that are fine again. Returns how many changed. */
export async function syncShopping(householdId: string): Promise<{ added: number; removed: number }> {
  const { data, error } = await supabase.rpc('rpc_shopping_sync', { p_household: householdId });
  if (error) throw error;
  return data as unknown as { added: number; removed: number };
}

export interface NewItem {
  productId?: string | null;
  freeText?: string | null;
  qty?: number | null;
  unitId?: string | null;
}

/**
 * Adds an item. A product that is already on the list (open) gets the quantity added when the
 * units agree, so the list never has the same product twice.
 */
export async function addListItem(householdId: string, item: NewItem, open: ListItem[]) {
  const existing = item.productId ? open.find((i) => i.product_id === item.productId && !i.done && !i.dismissed) : undefined;
  if (existing) {
    const sameUnit = !item.unitId || !existing.unit_id || existing.unit_id === item.unitId;
    const qty = item.qty && sameUnit ? (existing.qty ?? 0) + item.qty : (item.qty ?? existing.qty);
    return updateListItem(existing.id!, { qty: qty || null, unit_id: item.unitId ?? existing.unit_id });
  }
  const { error } = await supabase.from('shopping_list_item').insert({
    household_id: householdId,
    product_id: item.productId ?? null,
    free_text: item.productId ? null : (item.freeText?.trim() ?? null),
    qty: item.qty ?? null,
    unit_id: item.unitId ?? null,
  });
  if (error) throw error;
}

export async function updateListItem(
  id: string,
  patch: { qty?: number | null; unit_id?: string | null; note?: string | null; done?: boolean; dismissed?: boolean; free_text?: string },
) {
  const { error } = await supabase.from('shopping_list_item').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteListItem(id: string) {
  const { error } = await supabase.from('shopping_list_item').delete().eq('id', id);
  if (error) throw error;
}

export async function clearDone(householdId: string) {
  const { error } = await supabase.from('shopping_list_item').delete().eq('household_id', householdId).eq('done', true);
  if (error) throw error;
}
