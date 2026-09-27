// Blank label sheets (Phase 7b, migrations 56–57): print first, assign later. Codes (HL:TAG:…) are
// made by the database, never repeat and are never reused; a sheet can be reprinted with the same
// codes. A label becomes a place / thing / product on its first scan (rpc_tag_assign); "detach"
// makes the same sticker blank again, "retire" is final.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import type { BlankFormat, LabelSheet, LabelTag, TagTarget } from './tags';

export * from './tags';

const TAG_COLUMNS = 'id, code, sheet_id, slot, location_id, asset_id, product_id, assigned_at, retired_at';

export const labelsKey = (householdId: string, ...rest: unknown[]) => ['labels', householdId, ...rest] as const;

export const labelSheetsQuery = (householdId: string) =>
  queryOptions({
    queryKey: labelsKey(householdId, 'sheets'),
    queryFn: async (): Promise<LabelSheet[]> => {
      const { data, error } = await supabase
        .from('v_label_sheet')
        .select('id, household_id, sheet_no, format, slots, print_count, last_printed_at, created_at, unused, used, retired')
        .eq('household_id', householdId)
        .order('sheet_no', { ascending: false });
      if (error) throw error;
      return data as LabelSheet[];
    },
  });

/** Every label of one sheet, in slot order. */
export const sheetTagsQuery = (householdId: string, sheetId: string) =>
  queryOptions({
    queryKey: labelsKey(householdId, 'sheet', sheetId),
    queryFn: async (): Promise<LabelTag[]> => {
      const { data, error } = await supabase.from('label_tag').select(TAG_COLUMNS).eq('sheet_id', sheetId).order('slot');
      if (error) throw error;
      return data as LabelTag[];
    },
  });

/**
 * Labels that mean something (for the item pages' "Extra labels" and offline scans). Bounded by the
 * number of items, unlike blank ones (thousands after a while).
 */
export const assignedTagsQuery = (householdId: string) =>
  queryOptions({
    queryKey: labelsKey(householdId, 'tags'),
    queryFn: async (): Promise<LabelTag[]> => {
      const { data, error } = await supabase
        .from('label_tag')
        .select(`${TAG_COLUMNS}, sheet:label_sheet!label_tag_household_id_sheet_id_fkey (sheet_no)`)
        .eq('household_id', householdId)
        .is('retired_at', null)
        .or('location_id.not.is.null,asset_id.not.is.null,product_id.not.is.null')
        .order('assigned_at');
      if (error) throw error;
      return data as LabelTag[];
    },
  });

export function invalidateLabels(qc: QueryClient, householdId: string) {
  return qc.invalidateQueries({ queryKey: labelsKey(householdId) });
}

/** Makes `count` new sheets of never-used codes; returns them in order. */
export async function createSheets(householdId: string, format: BlankFormat, count: number, slots: number) {
  const { data, error } = await supabase.rpc('rpc_label_sheets', {
    p_household: householdId,
    p_format: format,
    p_count: count,
    p_slots: slots,
  });
  if (error) throw error;
  return data as unknown as Array<{ id: string; sheet_no: number }>;
}

export async function markPrinted(sheetId: string) {
  const { error } = await supabase.rpc('rpc_label_printed', { p_sheet: sheetId });
  if (error) throw error;
}

export async function assignTag(code: string, target: TagTarget) {
  const { error } = await supabase.rpc('rpc_tag_assign', { p_code: code, p_kind: target.kind, p_id: target.id });
  if (error) throw error;
}

/** Undo / "Detach this label": only if it still means `expectId`. */
export async function detachTag(code: string, expectId: string) {
  const { error } = await supabase.rpc('rpc_tag_detach', { p_code: code, p_expect_id: expectId });
  if (error) throw error;
}

export async function retireTag(code: string) {
  const { error } = await supabase.rpc('rpc_tag_retire', { p_code: code });
  if (error) throw error;
}

/** GDTAG detail → message key. */
export function tagErrorKey(e: unknown): 'assigned' | 'retired' | 'changed' | 'unknown' | 'denied' | 'generic' {
  const err = e as { code?: string; details?: string } | null;
  if (err?.code === 'GDTAG') {
    if (err.details === 'assigned' || err.details === 'retired' || err.details === 'changed') return err.details;
  }
  if (err?.code === '23503') return 'unknown';
  if (err?.code === '42501') return 'denied';
  return 'generic';
}
