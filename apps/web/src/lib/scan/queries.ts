// Scanned files from the claude.ai Bill Scanner's Drive folder (migration 54, Edge Function
// drive-scan). The function stores validated files; the app lists them, opens them in the normal
// import flow and marks warranty cards / rating plates as used. Status is derived in v_scan_file.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { Tables } from '../db.types';
import { supabase } from '../supabase';

export type ScanFile = Tables<'v_scan_file'>;
export type ScanStatus = 'waiting' | 'imported' | 'ignored' | 'error';

export const scanKey = (householdId: string, ...rest: unknown[]) => ['scan', householdId, ...rest] as const;
export const invalidateScan = (qc: QueryClient, householdId: string) => qc.invalidateQueries({ queryKey: scanKey(householdId) });

export const scanFilesQuery = (householdId: string) =>
  queryOptions({
    queryKey: scanKey(householdId, 'files'),
    queryFn: async (): Promise<ScanFile[]> => {
      const { data, error } = await supabase
        .from('v_scan_file')
        .select('*')
        .eq('household_id', householdId)
        .order('modified_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

export const driveSourceQuery = (householdId: string) =>
  queryOptions({
    queryKey: scanKey(householdId, 'source'),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('drive_source')
        .select('folder_id, last_sync_at, last_error')
        .eq('household_id', householdId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

/** A Drive folder link (…/folders/<id>?usp=…) or a bare id → the id, or null. */
export function folderIdFrom(input: string): string | null {
  const t = input.trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,100})/.exec(t) ?? /[?&]id=([A-Za-z0-9_-]{10,100})/.exec(t);
  const id = m ? m[1]! : t;
  return /^[A-Za-z0-9_-]{10,100}$/.test(id) ? id : null;
}

export async function setDriveFolder(householdId: string, folderId: string) {
  const { error } = await supabase
    .from('drive_source')
    .upsert({ household_id: householdId, folder_id: folderId }, { onConflict: 'household_id' });
  if (error) throw error;
}

export interface SyncResult {
  ok: boolean;
  skipped?: string;
  stored?: number;
  more?: boolean;
  error?: string;
}

/** Ask drive-scan to look for new files (throttled in the database: 5 min, 30 s with "Check now"). */
export async function syncDrive(householdId: string, force = false): Promise<SyncResult> {
  const { data, error } = await supabase.functions.invoke('drive-scan', { body: { household_id: householdId, force } });
  if (error) {
    // FunctionsHttpError carries the JSON reply ({ ok:false, error }) in its context.
    const ctx = (error as { context?: Response }).context;
    const body = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) : null;
    return { ok: false, error: (body as { error?: string } | null)?.error ?? 'network' };
  }
  return data as SyncResult;
}

export async function ignoreScanFile(id: string, ignored: boolean) {
  const { error } = await supabase.rpc('rpc_scan_file_ignore', { p_file: id, p_ignored: ignored });
  if (error) throw error;
}

export async function linkScanFileAsset(id: string, assetId: string) {
  const { error } = await supabase.rpc('rpc_scan_file_asset', { p_file: id, p_asset: assetId });
  if (error) throw error;
}
