import { parseScan, type ParsedScan } from './codes';
import type { Place } from './places';
import { supabase } from './supabase';

export interface ScanProduct {
  id: string;
  household_id: string;
  name: string;
  code: string;
}

export interface ScanAsset {
  id: string;
  household_id: string;
  name: string;
  code: string;
  asset_no: number;
  status: string;
  location_id: string | null;
}

export type Resolved =
  | { status: 'place'; place: Place }
  | { status: 'asset'; asset: ScanAsset }
  | {
      status: 'product';
      product: ScanProduct;
      /** Set when a barcode was scanned: one scan = qty × unit (null unit = the stock unit). */
      barcode: { code: string; unitId: string | null; qty: number } | null;
    }
  /** A retail barcode no product knows yet: offer "new product" / "add to a product". */
  | { status: 'unknownBarcode'; code: string }
  /** An old Grocy label (grcy:…): Grocy isn't imported, so these don't point at anything. */
  | { status: 'grocy'; raw: string }
  | { status: 'notFound'; code: string }
  /** A valid code for something that arrives in a later phase (lot labels, assets). */
  | { status: 'later'; parsed: ParsedScan; phase: number }
  | { status: 'invalid'; raw: string };

const LATER_PHASE: Record<string, number> = { lot: 7 };
const PRODUCT_COLUMNS = 'id, household_id, name, code';
// Same shape the database accepts for product_barcode.barcode (migration 24).
const BARCODE = /^[0-9A-Za-z._-]{4,64}$/;

async function byBarcode(code: string): Promise<Resolved | null> {
  const { data, error } = await supabase
    .from('product_barcode')
    .select('barcode, unit_id, qty, product_id')
    .eq('barcode', code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const product = await supabase.from('product').select(PRODUCT_COLUMNS).eq('id', data.product_id).maybeSingle();
  if (product.error) throw product.error;
  if (!product.data) return null;
  return { status: 'product', product: product.data, barcode: { code: data.barcode, unitId: data.unit_id, qty: data.qty } };
}

/** Scanned or typed text → what it points at. RLS limits lookups to the caller's household. */
export async function resolveScan(raw: string): Promise<Resolved> {
  const parsed = parseScan(raw);

  if (parsed.kind === 'unknown') {
    // Shop-printed barcodes (Code 128 …) aren't GTINs but can still be linked to a product.
    const text = parsed.raw.trim();
    if (BARCODE.test(text)) return (await byBarcode(text)) ?? { status: 'invalid', raw: parsed.raw };
    return { status: 'invalid', raw: parsed.raw };
  }
  if (parsed.kind === 'grocy') return { status: 'grocy', raw: parsed.raw };
  if (parsed.kind === 'ean') return (await byBarcode(parsed.digits)) ?? { status: 'unknownBarcode', code: parsed.digits };

  if (parsed.kind === 'prd') {
    const { data, error } = await supabase.from('product').select(PRODUCT_COLUMNS).eq('code', parsed.code).maybeSingle();
    if (error) throw error;
    return data ? { status: 'product', product: data, barcode: null } : { status: 'notFound', code: parsed.code };
  }
  if (parsed.kind === 'ast') {
    const { data, error } = await supabase
      .from('asset')
      .select('id, household_id, name, code, asset_no, status, location_id')
      .eq('code', parsed.code)
      .maybeSingle();
    if (error) throw error;
    return data ? { status: 'asset', asset: data } : { status: 'notFound', code: parsed.code };
  }
  if (parsed.kind !== 'loc') return { status: 'later', parsed, phase: LATER_PHASE[parsed.kind] ?? 7 };

  const { data, error } = await supabase
    .from('location')
    .select('id, household_id, parent_id, name, kind, climate, code, notes, sort, path, updated_at')
    .eq('code', parsed.code)
    .maybeSingle();
  if (error) throw error;
  return data ? { status: 'place', place: data } : { status: 'notFound', code: parsed.code };
}
