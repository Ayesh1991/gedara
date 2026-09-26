import type { QueryClient } from '@tanstack/react-query';
import { parseScan, type ParsedScan } from './codes';
import { resolveFromCatalogue, type Catalogue } from './offline/catalogue';
import type { Membership } from './queries';
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

/** One labelled lot (HL:LOT): "this freezer bag". */
export interface ScanLot {
  id: string;
  code: string;
  qty_remaining: number;
  location_id: string | null;
  due_date: string | null;
  opened_at: string | null;
}

export type Resolved =
  | { status: 'place'; place: Place }
  | { status: 'asset'; asset: ScanAsset }
  | {
      status: 'product';
      product: ScanProduct;
      /** Set when a barcode was scanned: one scan = qty × unit (null unit = the stock unit). */
      barcode: { code: string; unitId: string | null; qty: number } | null;
      /** Set when a lot label was scanned: actions use that lot. */
      lot?: ScanLot | null;
    }
  /** A retail barcode no product knows yet: offer "new product" / "add to a product". */
  | { status: 'unknownBarcode'; code: string }
  /** An old Grocy label (grcy:…): Grocy isn't imported, so these don't point at anything. */
  | { status: 'grocy'; raw: string }
  | { status: 'notFound'; code: string }
  /** Offline, and this code isn't in the saved catalogue (things, lots): try again online. */
  | { status: 'offline'; parsed: ParsedScan }
  | { status: 'invalid'; raw: string };

const PRODUCT_COLUMNS = 'id, household_id, name, code';
// Same shape the database accepts for product_barcode.barcode (migration 24).
const BARCODE = /^[0-9A-Za-z._-]{4,64}$/;

// ── Offline: the saved catalogue (lib/offline/persist) ────────────────────────
let cacheClient: QueryClient | null = null;
/** main.tsx hands the QueryClient over so scans can be resolved from its cache when offline. */
export function setResolverCache(qc: QueryClient) {
  cacheClient = qc;
}

function catalogue(): Catalogue | null {
  const qc = cacheClient;
  const hh = qc?.getQueryData<Membership | null>(['membership'])?.household.id;
  if (!qc || !hh) return null;
  return {
    products: qc.getQueryData<ScanProduct[]>(['pantry', hh, 'products']) ?? [],
    barcodes: qc.getQueryData<Catalogue['barcodes']>(['pantry', hh, 'barcodes']) ?? [],
    places: qc.getQueryData<Place[]>(['places', hh]) ?? [],
  };
}

/** No network (as opposed to "the database said no"): fetch failures carry no SQLSTATE / PGRST code. */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof TypeError || !code;
}

// ── Online ────────────────────────────────────────────────────────────────────
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

async function resolveOnline(parsed: ParsedScan): Promise<Resolved> {
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
  if (parsed.kind === 'lot') {
    const { data, error } = await supabase
      .from('stock_lot')
      .select('id, code, qty_remaining, location_id, due_date, opened_at, product:product!stock_lot_household_id_product_id_fkey (id, household_id, name, code)')
      .eq('code', parsed.code)
      .maybeSingle();
    if (error) throw error;
    if (!data?.product || !data.code) return { status: 'notFound', code: parsed.code };
    const { product, ...lot } = data;
    return { status: 'product', product, barcode: null, lot: { ...lot, code: data.code, qty_remaining: Number(lot.qty_remaining) } };
  }

  const { data, error } = await supabase
    .from('location')
    .select('id, household_id, parent_id, name, kind, climate, code, notes, sort, path, updated_at')
    .eq('code', parsed.code)
    .maybeSingle();
  if (error) throw error;
  return data ? { status: 'place', place: data } : { status: 'notFound', code: parsed.code };
}

/** Scanned or typed text → what it points at. RLS limits lookups to the caller's household. */
export async function resolveScan(raw: string): Promise<Resolved> {
  const parsed = parseScan(raw);
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  const c = catalogue();
  if (offline && c) return resolveFromCatalogue(parsed, c);
  try {
    return await resolveOnline(parsed);
  } catch (e) {
    if (c && isNetworkError(e)) return resolveFromCatalogue(parsed, c);
    throw e;
  }
}
