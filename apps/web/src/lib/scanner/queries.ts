// Bin-scanner data access (Phase 11). Reads straight from the tables (RLS: members read); every
// write is an RPC. A scanner is a row of `device` with kind 'scanner'; its scans are `bin_scan`.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { DeviceStatus, ScanMode, ScanStatus, ScannerSettings } from '@scanner/protocol';
import type { Json } from '../db.types';
import { env } from '../env';
import { invalidatePantry } from '../pantry/queries';
import { supabase } from '../supabase';

export const scannerKey = (householdId: string, ...rest: unknown[]) => ['scanner', householdId, ...rest] as const;

/** Scans, scanners, stock and the shopping list all changed: one call after any scanner action. */
export function invalidateScanner(qc: QueryClient, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['scanner', householdId] }),
    invalidatePantry(qc, householdId),
    qc.invalidateQueries({ queryKey: ['shopping', householdId] }),
    qc.invalidateQueries({ queryKey: ['attention', householdId] }),
  ]);
}

/** The project the scanner's setup portal must point at ("gedara" or "gedara-staging"). */
export function scannerServerName(): string {
  return env.VITE_APP_ENV === 'prod' ? 'gedara' : 'gedara-staging';
}

// ── Devices ───────────────────────────────────────────────────────────────────
export type PausedReason = 'manual' | 'minute' | 'day' | 'add_day';

export interface ScannerDevice {
  id: string;
  household_id: string;
  name: string;
  token_hint: string;
  settings: ScannerSettings;
  settings_version: number;
  last_seen_at: string | null;
  fw_version: string | null;
  status: (DeviceStatus & { boot?: number; up?: number }) | null;
  reading_count: number;
  paused_at: string | null;
  paused_reason: PausedReason | null;
  created_at: string;
  revoked_at: string | null;
}

const DEVICE_COLUMNS = `id, household_id, name, token_hint, settings, settings_version, last_seen_at, fw_version, status,
  reading_count, paused_at, paused_reason, created_at, revoked_at`;

export const scannersQuery = (householdId: string) =>
  queryOptions({
    queryKey: scannerKey(householdId, 'devices'),
    queryFn: async (): Promise<ScannerDevice[]> => {
      const { data, error } = await supabase
        .from('device')
        .select(DEVICE_COLUMNS)
        .eq('household_id', householdId)
        .eq('kind', 'scanner')
        .order('created_at');
      if (error) throw error;
      return data as unknown as ScannerDevice[];
    },
    staleTime: 15 * 1000,
  });

export async function createScanner(householdId: string, name: string): Promise<{ id: string; token: string }> {
  const { data, error } = await supabase.rpc('rpc_scanner_create', { p_household: householdId, p_name: name });
  if (error) throw error;
  return data as unknown as { id: string; token: string };
}

export async function revokeScanner(id: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_revoke', { p_id: id });
  if (error) throw error;
}

export async function updateScanner(id: string, p: { name?: string; settings?: Partial<ScannerSettings> }): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_update', { p_id: id, p: p as Json });
  if (error) throw error;
}

export type ScannerCommand = 'beep' | 'identify' | 'reboot' | 'ota';

export async function sendScannerCommand(id: string, command: ScannerCommand, args: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_device_command', { p_device: id, p_command: command, p_args: args as Json });
  if (error) throw error;
  return data as string;
}

export async function pauseScanner(id: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_scanner_pause', { p_id: id });
  if (error) throw error;
}

/** Owner only. What to do with the scans kept while it was paused. */
export async function resumeScanner(id: string, held: 'apply' | 'drop' | 'keep'): Promise<{ held: number }> {
  const { data, error } = await supabase.rpc('rpc_scanner_resume', { p_id: id, p_held: held });
  if (error) throw error;
  return data as unknown as { held: number };
}

/** Owner only: take back everything this scanner did since a moment. */
export async function undoScannerSince(id: string, since: Date): Promise<{ undone: number; failed: number }> {
  const { data, error } = await supabase.rpc('rpc_scanner_undo_since', { p_id: id, p_since: since.toISOString() });
  if (error) throw error;
  return data as unknown as { undone: number; failed: number };
}

// ── Scans ─────────────────────────────────────────────────────────────────────
export interface ScanResultJson {
  name?: string | null;
  unit?: string | null;
  sized?: boolean | null;
  pack?: number | null;
  on_list?: boolean | null;
  jar?: string | null;
  due?: string | null;
  bill_qty?: number | null;
  bill_on?: string | null;
  reason?: string | null;
  [k: string]: unknown;
}

export interface BinScan {
  id: string;
  household_id: string;
  device_id: string | null;
  at: string;
  received_at: string;
  time_estimated: boolean;
  kind: 'scan' | 'undo';
  mode: ScanMode | null;
  count: number;
  code: string | null;
  code_kind: string | null;
  product_id: string | null;
  lot_id: string | null;
  status: ScanStatus;
  qty: number | null;
  left_qty: number | null;
  correlation_id: string | null;
  bill_line_id: string | null;
  undone_at: string | null;
  resolved_at: string | null;
  result: ScanResultJson;
}

export const SCAN_COLUMNS = `id, household_id, device_id, at, received_at, time_estimated, kind, mode, count, code, code_kind,
  product_id, lot_id, status, qty, left_qty, correlation_id, bill_line_id, undone_at, resolved_at, result`;

export const scansQuery = (householdId: string, f: { deviceId?: string; limit?: number } = {}) =>
  queryOptions({
    queryKey: scannerKey(householdId, 'scans', f.deviceId ?? null, f.limit ?? 30),
    queryFn: async (): Promise<BinScan[]> => {
      let q = supabase.from('bin_scan').select(SCAN_COLUMNS).eq('household_id', householdId);
      if (f.deviceId) q = q.eq('device_id', f.deviceId);
      const { data, error } = await q.order('received_at', { ascending: false }).order('seq', { ascending: false }).limit(f.limit ?? 30);
      if (error) throw error;
      return data as unknown as BinScan[];
    },
    staleTime: 10 * 1000,
  });

/** "Needs you": barcodes to link, Add after a bill, scans kept while paused. Oldest first. */
export const waitingScansQuery = (householdId: string) =>
  queryOptions({
    queryKey: scannerKey(householdId, 'waiting'),
    queryFn: async (): Promise<BinScan[]> => {
      const { data, error } = await supabase
        .from('bin_scan')
        .select(SCAN_COLUMNS)
        .eq('household_id', householdId)
        .in('status', ['unknown', 'bill_guard', 'held'])
        .order('at')
        .limit(200);
      if (error) throw error;
      return data as unknown as BinScan[];
    },
    staleTime: 10 * 1000,
  });

export async function undoScan(id: string): Promise<{ left_qty?: number | null }> {
  const { data, error } = await supabase.rpc('rpc_bin_scan_undo', { p_scan: id });
  if (error) throw error;
  return data as unknown as { left_qty?: number | null };
}

/** apply: the barcode is linked now / "add it anyway" / apply a held scan. dismiss: drop it. */
export async function resolveScan(id: string, choice: 'apply' | 'dismiss'): Promise<{ status: ScanStatus; applied: number; left_qty?: number | null }> {
  const { data, error } = await supabase.rpc('rpc_bin_scan_resolve', { p_scan: id, p_choice: choice });
  if (error) throw error;
  return data as unknown as { status: ScanStatus; applied: number; left_qty?: number | null };
}

/** Link a scanned barcode to a product (one scan = `qty` of `unitId`), then apply the waiting scans of it. */
export async function linkBarcode(
  householdId: string,
  scanId: string,
  code: string,
  productId: string,
  pack?: { qty: number; unitId: string | null },
): Promise<{ status: ScanStatus; applied: number }> {
  const { error } = await supabase
    .from('product_barcode')
    .insert({ household_id: householdId, product_id: productId, barcode: code, qty: pack?.qty ?? 1, unit_id: pack?.unitId ?? null });
  // 23505: someone linked it meanwhile; the resolve below then uses that link.
  if (error && error.code !== '23505') throw error;
  return resolveScan(scanId, 'apply');
}

export interface SettledItem {
  product_id: string;
  name: string;
  qty: number;
  unit: string;
}

/** After a bill stocked the pantry: packs the scanner's Add had already put in are not counted twice. */
export async function settleBillAdds(transactionId: string): Promise<{ correlation_id: string | null; items: SettledItem[] }> {
  const { data, error } = await supabase.rpc('rpc_bin_add_settle', { p_transaction: transactionId });
  if (error) throw error;
  return data as unknown as { correlation_id: string | null; items: SettledItem[] };
}

// ── Errors ────────────────────────────────────────────────────────────────────
export type ScannerError = 'denied' | 'invalid' | 'noStock' | 'unitMismatch' | 'handled' | 'cantUndo' | 'duplicate' | 'reference' | 'generic';

export function scannerErrorKey(e: unknown): ScannerError {
  const code = (e as { code?: string } | null)?.code;
  if (code === '42501') return 'denied';
  if (code === '23514' || code === '22023') return 'invalid';
  if (code === 'GDSTK') return 'noStock';
  if (code === 'GDUNT') return 'unitMismatch';
  if (code === 'GDDEC') return 'handled';
  if (code === 'GDUND') return 'cantUndo';
  if (code === '23505') return 'duplicate';
  if (code === '23503') return 'reference';
  return 'generic';
}
