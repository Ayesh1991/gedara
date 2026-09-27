// Blank labels (Phase 7b): types and pure helpers, safe to import from tests and the offline
// catalogue (no Supabase client here; the queries live in ./blank).

export type BlankFormat = 'a4' | 'a4mini' | 'sq20' | 'sq10';
export const BLANK_FORMATS: readonly BlankFormat[] = ['a4', 'a4mini', 'sq20', 'sq10'];
/** NIIMBOT rolls: labels per batch. */
export const NIIMBOT_BATCHES = [10, 20, 50] as const;

export type TagKind = 'location' | 'asset' | 'product';

export interface LabelSheet {
  id: string;
  household_id: string;
  sheet_no: number;
  format: BlankFormat;
  slots: number;
  print_count: number;
  last_printed_at: string | null;
  created_at: string;
  unused: number;
  used: number;
  retired: number;
}

export interface LabelTag {
  id: string;
  code: string;
  sheet_id: string;
  slot: number;
  location_id: string | null;
  asset_id: string | null;
  product_id: string | null;
  assigned_at: string | null;
  retired_at: string | null;
  /** Embedded where a label is listed on its item ("Extra labels"). */
  sheet?: { sheet_no: number } | null;
}

export interface TagTarget {
  kind: TagKind;
  id: string;
}

export function tagTarget(t: Pick<LabelTag, 'location_id' | 'asset_id' | 'product_id'>): TagTarget | null {
  if (t.location_id) return { kind: 'location', id: t.location_id };
  if (t.asset_id) return { kind: 'asset', id: t.asset_id };
  if (t.product_id) return { kind: 'product', id: t.product_id };
  return null;
}

export function tagState(t: Pick<LabelTag, 'location_id' | 'asset_id' | 'product_id' | 'retired_at'>): 'blank' | 'used' | 'retired' {
  if (t.retired_at) return 'retired';
  return tagTarget(t) ? 'used' : 'blank';
}

/** Human position of a label, printed under the QR: "S7 · 12" (A4) / "S7-12" (NIIMBOT ≤ 10 chars). */
export function blankLabelText(sheetNo: number, slot: number, short = false): string {
  return short ? `S${sheetNo}-${slot + 1}` : `S${sheetNo} · ${slot + 1}`;
}
