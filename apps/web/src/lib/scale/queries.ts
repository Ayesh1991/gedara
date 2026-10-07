// Kitchen-scale data access (Phase 6b). Reads straight from the tables (RLS: members read); every
// write is an RPC, except a container's product and empty weight, which are plain column updates on
// `location` (column grants + a trigger that checks the product is weighable, migration 63).
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { DeviceStatus, ReadingStatus } from '@scale/protocol';
import type { Json } from '../db.types';
import { env } from '../env';
import { invalidatePantry } from '../pantry/queries';
import { placesKey } from '../places';
import { supabase } from '../supabase';
import { checkFirmware, sha256Hex, type FirmwareProblem } from './espImage';

export const scaleKey = (householdId: string, ...rest: unknown[]) => ['scale', householdId, ...rest] as const;

/** Readings, devices, containers and stock all changed: one call after any scale action. */
export function invalidateScale(qc: QueryClient, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['scale', householdId] }),
    invalidatePantry(qc, householdId),
    qc.invalidateQueries({ queryKey: placesKey(householdId) }),
  ]);
}

export function scaleIngestUrl(): string {
  return `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/scale-ingest`;
}

/** The project the scale's setup portal must point at ("gedara" or "gedara-staging"). */
export function scaleServerName(): string {
  return env.VITE_APP_ENV === 'prod' ? 'gedara' : 'gedara-staging';
}

// ── Devices ───────────────────────────────────────────────────────────────────
export interface ScaleSettings {
  volume: number;
  quiet_from: string;
  quiet_to: string;
  voice: boolean;
  threshold_g: number;
}

export type LiveState = 'empty' | 'settling' | 'stable' | 'overload' | 'no_tag' | 'setup' | 'error';

export interface ScaleDevice {
  id: string;
  household_id: string;
  name: string;
  token_hint: string;
  settings: ScaleSettings;
  settings_version: number;
  calibrated_at: string | null;
  last_seen_at: string | null;
  fw_version: string | null;
  status: (DeviceStatus & { boot?: number; up?: number }) | null;
  live_state: LiveState | null;
  live_uid: string | null;
  live_gross_g: number | null;
  live_at: string | null;
  watch_until: string | null;
  reading_count: number;
  created_at: string;
  revoked_at: string | null;
}

const DEVICE_COLUMNS = `id, household_id, name, token_hint, settings, settings_version, calibrated_at, last_seen_at,
  fw_version, status, live_state, live_uid, live_gross_g, live_at, watch_until, reading_count, created_at, revoked_at`;

export const scalesQuery = (householdId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'devices'),
    queryFn: async (): Promise<ScaleDevice[]> => {
      const { data, error } = await supabase
        .from('device')
        .select(DEVICE_COLUMNS)
        .eq('household_id', householdId)
        .eq('kind', 'scale')
        .order('created_at');
      if (error) throw error;
      return data as unknown as ScaleDevice[];
    },
    staleTime: 15 * 1000,
  });

export async function createScale(householdId: string, name: string): Promise<{ id: string; token: string }> {
  const { data, error } = await supabase.rpc('rpc_device_create', { p_household: householdId, p_name: name });
  if (error) throw error;
  return data as { id: string; token: string };
}

export async function revokeScale(id: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_revoke', { p_id: id });
  if (error) throw error;
}

export async function updateScale(id: string, p: { name?: string; settings?: Partial<ScaleSettings> }): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_update', { p_id: id, p: p as Json });
  if (error) throw error;
}

/** Fast polling while someone watches (calibration); 0 stops it. */
export async function watchScale(id: string, minutes = 10): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_watch', { p_id: id, p_minutes: minutes });
  if (error) throw error;
}

export type ScaleCommand = 'tare' | 'calibrate' | 'beep' | 'identify' | 'reboot' | 'ota';

export async function sendCommand(id: string, command: ScaleCommand, args: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_device_command', { p_device: id, p_command: command, p_args: args as Json });
  if (error) throw error;
  return data as string;
}

export interface DeviceCommandRow {
  id: string;
  device_id: string;
  command: ScaleCommand;
  args: Record<string, unknown>;
  status: 'queued' | 'sent' | 'done' | 'failed' | 'expired';
  result: Record<string, unknown> | null;
  created_at: string;
  done_at: string | null;
}

/** Polls a command until the device answers (done / failed / expired) or `timeoutMs` passes. */
export async function waitForCommand(commandId: string, timeoutMs = 90_000, everyMs = 1500): Promise<DeviceCommandRow['status']> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { data, error } = await supabase.from('device_command').select('status').eq('id', commandId).maybeSingle();
    if (error) throw error;
    const s = (data as { status: DeviceCommandRow['status'] } | null)?.status;
    if (s === 'done' || s === 'failed' || s === 'expired') return s;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return 'expired';
}

// ── Readings ──────────────────────────────────────────────────────────────────
export interface ScaleReading {
  id: string;
  household_id: string;
  device_id: string | null;
  at: string;
  received_at: string;
  time_estimated: boolean;
  uid: string | null;
  location_id: string | null;
  product_id: string | null;
  gross_g: number | null;
  tare_g: number | null;
  net_g: number | null;
  stock_before_g: number | null;
  delta_g: number | null;
  moved_g: number | null;
  pending_g: number | null;
  status: ReadingStatus;
  correlation_id: string | null;
  decision: { later_at?: string; choice?: string; correlation_id?: string | null; moved_g?: number } | null;
  result: { name?: string | null; container?: string | null; left_g?: number | null; linked?: boolean } & Record<string, unknown>;
}

export const READING_COLUMNS = `id, household_id, device_id, at, received_at, time_estimated, uid, location_id, product_id,
  gross_g, tare_g, net_g, stock_before_g, delta_g, moved_g, pending_g, status, correlation_id, decision, result`;

export const readingsQuery = (householdId: string, f: { deviceId?: string; locationId?: string; limit?: number } = {}) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'readings', f.deviceId ?? null, f.locationId ?? null, f.limit ?? 20),
    queryFn: async (): Promise<ScaleReading[]> => {
      let q = supabase.from('scale_reading').select(READING_COLUMNS).eq('household_id', householdId);
      if (f.deviceId) q = q.eq('device_id', f.deviceId);
      if (f.locationId) q = q.eq('location_id', f.locationId);
      const { data, error } = await q.order('received_at', { ascending: false }).limit(f.limit ?? 20);
      if (error) throw error;
      return data as unknown as ScaleReading[];
    },
    staleTime: 10 * 1000,
  });

/** Open questions: heavier jars waiting for a decision, and new tags from the last week. */
export const openReadingsQuery = (householdId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'open'),
    queryFn: async (): Promise<ScaleReading[]> => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('scale_reading')
        .select(READING_COLUMNS)
        .eq('household_id', householdId)
        .or(`status.eq.needs_decision,and(status.eq.unknown_tag,received_at.gte.${since})`)
        .order('received_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data as unknown as ScaleReading[];
    },
    staleTime: 10 * 1000,
  });

export type Decision = 'transfer' | 'adjust' | 'later';

export async function decideReading(id: string, choice: Decision): Promise<{ status: string; correlation_id: string | null; left_g: number }> {
  const { data, error } = await supabase.rpc('rpc_scale_decide', { p_reading: id, p_choice: choice });
  if (error) throw error;
  return data as { status: string; correlation_id: string | null; left_g: number };
}

/** A weight from another scale typed in. Idempotent by op id (a double tap weighs once). */
export async function weighByHand(locationId: string, netG: number, opId = crypto.randomUUID()) {
  const { data, error } = await supabase.rpc('rpc_weigh', { p_op_id: opId, p_location: locationId, p_net_g: netG });
  if (error) throw error;
  return data as { status: ReadingStatus; delta_g?: number; left_g?: number; correlation_id?: string | null; name?: string };
}

// ── Containers and tags ───────────────────────────────────────────────────────
export interface Container {
  id: string;
  name: string;
  code: string;
  kind: string | null;
  path: string;
  tare_g: number | null;
  tare_set_at: string | null;
  holds_product_id: string | null;
  scale_setup_until: string | null;
  product: { id: string; name: string } | null;
  tag: { id: string; uid: string; last_seen_at: string | null } | null;
}

const CONTAINER_COLUMNS = `id, name, code, kind, path, tare_g, tare_set_at, holds_product_id, scale_setup_until,
  product:product!location_holds_product_fk(id, name), tag:nfc_tag(id, uid, last_seen_at)`;

type ContainerRow = Omit<Container, 'tag'> & { tag: Container['tag'] | Container['tag'][] };
const one = (r: ContainerRow): Container => ({ ...r, tag: Array.isArray(r.tag) ? (r.tag[0] ?? null) : r.tag });

/** Places that are containers or already hold a product (the scale's jars). */
export const containersQuery = (householdId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'containers'),
    queryFn: async (): Promise<Container[]> => {
      const { data, error } = await supabase
        .from('location')
        .select(CONTAINER_COLUMNS)
        .eq('household_id', householdId)
        .or('kind.eq.container,holds_product_id.not.is.null')
        .order('path');
      if (error) throw error;
      return (data as unknown as ContainerRow[]).map(one);
    },
    staleTime: 30 * 1000,
  });

export const containerQuery = (householdId: string, locationId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'container', locationId),
    queryFn: async (): Promise<Container | null> => {
      const { data, error } = await supabase.from('location').select(CONTAINER_COLUMNS).eq('id', locationId).maybeSingle();
      if (error) throw error;
      return data ? one(data as unknown as ContainerRow) : null;
    },
    staleTime: 10 * 1000,
  });

/** Containers holding this product (product page). */
export const productContainersQuery = (householdId: string, productId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'product-containers', productId),
    queryFn: async (): Promise<Container[]> => {
      const { data, error } = await supabase
        .from('location')
        .select(CONTAINER_COLUMNS)
        .eq('household_id', householdId)
        .eq('holds_product_id', productId)
        .order('path');
      if (error) throw error;
      return (data as unknown as ContainerRow[]).map(one);
    },
    staleTime: 30 * 1000,
  });

export async function setContainer(locationId: string, p: { holds_product_id?: string | null; tare_g?: number | null }) {
  const { error } = await supabase.from('location').update(p).eq('id', locationId);
  if (error) throw error;
}

/** "Weigh empty": the next scale reading of this jar (or of a new tag) becomes its empty weight. */
export async function armWeighEmpty(locationId: string, on = true): Promise<string | null> {
  const { data, error } = await supabase.rpc('rpc_container_setup', { p_location: locationId, p_on: on });
  if (error) throw error;
  return data as string | null;
}

export async function linkTag(locationId: string, uid: string, move = false) {
  const { data, error } = await supabase.rpc('rpc_nfc_tag_link', { p_location: locationId, p_uid: uid, p_move: move });
  if (error) throw error;
  return data as { id: string; uid: string; location_id: string; moved_from: string | null };
}

export async function unlinkTag(tagId: string) {
  const { error } = await supabase.rpc('rpc_nfc_tag_unlink', { p_id: tagId });
  if (error) throw error;
}

/** For GDTAG: the place the tag belongs to now (the error's DETAIL). */
export function tagOwner(e: unknown): string | null {
  const d = (e as { details?: string } | null)?.details;
  return d && /^[0-9a-f-]{36}$/.test(d) ? d : null;
}

// ── Firmware ──────────────────────────────────────────────────────────────────
export interface Firmware {
  id: string;
  version: string;
  sha256: string;
  size: number;
  created_at: string;
  notes: string | null;
}

export const firmwareQuery = (householdId: string) =>
  queryOptions({
    queryKey: scaleKey(householdId, 'firmware'),
    queryFn: async (): Promise<Firmware[]> => {
      const { data, error } = await supabase
        .from('device_firmware')
        .select('id, version, sha256, size, created_at, notes')
        .eq('household_id', householdId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data as Firmware[];
    },
    staleTime: 60 * 1000,
  });

export class FirmwareFileError extends Error {
  constructor(public readonly problem: FirmwareProblem) {
    super(problem);
  }
}

/** Check the file, store it, register it. Returns the new firmware row's id and version. */
export async function uploadFirmware(householdId: string, file: File): Promise<{ id: string; version: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkFirmware(bytes);
  if (!check.ok) throw new FirmwareFileError(check.problem);
  const sha256 = await sha256Hex(bytes);
  const path = `${householdId}/scale/${check.info.version}.bin`;
  const { error: upErr } = await supabase.storage
    .from('device-firmware')
    .upload(path, new Blob([bytes], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false });
  if (upErr && !/exists|duplicate/i.test(upErr.message)) throw upErr;
  const { data, error } = await supabase.rpc('rpc_device_firmware_add', {
    p_household: householdId,
    p: { path, version: check.info.version, project: check.info.project, sha256, size: bytes.length } as Json,
  });
  if (error) throw error;
  return { id: data as string, version: check.info.version };
}

// ── Errors ────────────────────────────────────────────────────────────────────
export type ScaleError =
  | 'denied'
  | 'invalid'
  | 'noStock'
  | 'unitMismatch'
  | 'notEmpty'
  | 'tagTaken'
  | 'decided'
  | 'cantUndo'
  | 'duplicate'
  | 'reference'
  | 'generic';

export function scaleErrorKey(e: unknown): ScaleError {
  const code = (e as { code?: string } | null)?.code;
  if (code === '42501') return 'denied';
  if (code === '23514' || code === '22023') return 'invalid';
  if (code === 'GDSTK') return 'noStock';
  if (code === 'GDUNT') return 'unitMismatch';
  if (code === 'GDCNE') return 'notEmpty';
  if (code === 'GDTAG') return 'tagTaken';
  if (code === 'GDDEC') return 'decided';
  if (code === 'GDUND') return 'cantUndo';
  if (code === '23505') return 'duplicate';
  if (code === '23503') return 'reference';
  return 'generic';
}
