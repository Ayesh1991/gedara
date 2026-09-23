import { parseScan, type ParsedScan } from './codes';
import type { Place } from './places';
import { supabase } from './supabase';

export type Resolved =
  | { status: 'place'; place: Place }
  | { status: 'notFound'; code: string }
  /** A valid code for something that arrives in a later phase (products, lots, assets, barcodes). */
  | { status: 'later'; parsed: ParsedScan; phase: number }
  | { status: 'invalid'; raw: string };

const LATER_PHASE: Record<string, number> = { prd: 3, lot: 3, ean: 3, grocy: 3, ast: 5 };

/** Scanned or typed text → what it points at. RLS limits lookups to the caller's household. */
export async function resolveScan(raw: string): Promise<Resolved> {
  const parsed = parseScan(raw);
  if (parsed.kind === 'unknown') return { status: 'invalid', raw: parsed.raw };
  if (parsed.kind !== 'loc') return { status: 'later', parsed, phase: LATER_PHASE[parsed.kind] ?? 3 };

  const { data, error } = await supabase
    .from('location')
    .select('id, household_id, parent_id, name, kind, climate, code, notes, sort, path, updated_at')
    .eq('code', parsed.code)
    .maybeSingle();
  if (error) throw error;
  return data ? { status: 'place', place: data } : { status: 'notFound', code: parsed.code };
}
