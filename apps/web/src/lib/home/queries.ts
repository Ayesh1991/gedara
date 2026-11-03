// Home Assistant in Gedara (Phase 8) — data access. The bridge on the Gedara Pi reports doors,
// windows, lights, switches and the AC into home_entity (RLS: members read); the owner chooses what
// shows and what may be controlled (rpc_home_entity_set), owner and members send commands
// (rpc_home_command), and the bridge carries them out through Home Assistant's own API. Nothing
// here ever sees Home Assistant's token: it stays on the Pi.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { HaState, HomeAction } from '@home/protocol';
import type { Json } from '../db.types';
import { supabase } from '../supabase';
import type { HomeEntity, HomeEvent } from './logic';

export * from './logic';

export const homeKey = (householdId: string, ...rest: unknown[]) => ['home', householdId, ...rest] as const;

export function invalidateHome(qc: QueryClient, householdId: string, what?: 'bridge' | 'entities' | 'events' | 'alerts') {
  return qc.invalidateQueries({ queryKey: what ? homeKey(householdId, what) : homeKey(householdId) });
}

// ── The bridge ────────────────────────────────────────────────────────────────
export interface BridgeStatus {
  ha?: HaState;
  ha_version?: string;
  entities?: number;
  up?: number;
}

export interface Bridge {
  id: string;
  household_id: string;
  name: string;
  token_hint: string;
  last_seen_at: string | null;
  fw_version: string | null;
  status: BridgeStatus | null;
  created_at: string;
}

export const bridgeQuery = (householdId: string) =>
  queryOptions({
    queryKey: homeKey(householdId, 'bridge'),
    queryFn: async (): Promise<Bridge | null> => {
      const { data, error } = await supabase
        .from('device')
        .select('id, household_id, name, token_hint, last_seen_at, fw_version, status, created_at')
        .eq('household_id', householdId)
        .eq('kind', 'home')
        .is('revoked_at', null)
        .order('created_at')
        .limit(1);
      if (error) throw error;
      return ((data ?? [])[0] as unknown as Bridge | undefined) ?? null;
    },
    staleTime: 15_000,
  });

export type PairResult = { ok: true; id: string } | { ok: false; error: 'GDPCN' };

export async function pairBridge(householdId: string, code: string, name: string): Promise<PairResult> {
  const { data, error } = await supabase.rpc('rpc_device_pair', { p_household: householdId, p_code: code, p_name: name, p_kind: 'home' });
  if (error) throw error;
  return data as unknown as PairResult;
}

export async function renameBridge(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_update', { p_id: id, p: { name } as Json });
  if (error) throw error;
}

export async function removeBridge(id: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_revoke', { p_id: id });
  if (error) throw error;
}

// ── Entities ──────────────────────────────────────────────────────────────────
const ENTITY_COLUMNS = `id, household_id, device_id, entity_id, domain, kind, ha_name, label, area, device_class, state, attrs,
  shown, controllable, platform, unit, logged, alert, changed_at, updated_at`;

export const entitiesQuery = (householdId: string) =>
  queryOptions({
    queryKey: homeKey(householdId, 'entities'),
    queryFn: async (): Promise<HomeEntity[]> => {
      const { data, error } = await supabase.from('home_entity').select(ENTITY_COLUMNS).eq('household_id', householdId).limit(1000);
      if (error) throw error;
      return data as unknown as HomeEntity[];
    },
    staleTime: 30_000,
  });

export async function setEntity(id: string, p: { shown?: boolean; controllable?: boolean; label?: string | null; logged?: boolean; alert?: boolean }) {
  const { data, error } = await supabase.rpc('rpc_home_entity_set', { p_id: id, p: p as Json });
  if (error) throw error;
  return data as unknown as Pick<HomeEntity, 'id' | 'shown' | 'controllable' | 'label' | 'logged' | 'alert'>;
}

// ── The house log (Phase 8b) ──────────────────────────────────────────────────
export type LogFilter = 'all' | 'openings' | 'people' | 'sensors';
const FILTER_KINDS: Record<Exclude<LogFilter, 'all'>, string[]> = {
  openings: ['door', 'window'],
  people: ['presence'],
  sensors: ['sensor', 'binary'],
};
export const LOG_PAGE = 200;

/** Newest first, 200 at a time (`before`: the oldest `at` already shown). `day`: YYYY-MM-DD in the household's time zone. */
export async function fetchEvents(householdId: string, o: { filter: LogFilter; room: string | null; before?: string; day?: { from: string; to: string } }) {
  let q = supabase
    .from('home_event')
    .select('id, entity, entity_id, name, area, kind, state, value, unit, at')
    .eq('household_id', householdId)
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(LOG_PAGE);
  if (o.filter !== 'all') q = q.in('kind', FILTER_KINDS[o.filter]);
  if (o.room) q = q.eq('area', o.room);
  if (o.before) q = q.lt('at', o.before);
  if (o.day) q = q.gte('at', o.day.from).lt('at', o.day.to);
  const { data, error } = await q;
  if (error) throw error;
  return (data as unknown as HomeEvent[]).map((e) => ({ ...e, value: e.value === null ? null : Number(e.value) }));
}

// ── Each person's alerts (Phase 8b) ───────────────────────────────────────────
export type AlertWhen = 'off' | 'always' | 'night';
export interface AlertPref {
  doors: AlertWhen;
  presence: AlertWhen;
  night_from: string; // HH:MM
  night_to: string;
}
export const DEFAULT_ALERT_PREF: AlertPref = { doors: 'off', presence: 'off', night_from: '22:00', night_to: '06:00' };

export const alertPrefQuery = (householdId: string) =>
  queryOptions({
    queryKey: homeKey(householdId, 'alerts'),
    queryFn: async (): Promise<AlertPref> => {
      const { data, error } = await supabase.from('home_alert_pref').select('doors, presence, night_from, night_to').eq('household_id', householdId).maybeSingle();
      if (error) throw error;
      const r = data as { doors: AlertWhen; presence: AlertWhen; night_from: string; night_to: string } | null;
      return r ? { ...r, night_from: r.night_from.slice(0, 5), night_to: r.night_to.slice(0, 5) } : DEFAULT_ALERT_PREF;
    },
    staleTime: 60_000,
  });

export async function setAlertPref(householdId: string, p: Partial<AlertPref>): Promise<AlertPref> {
  const { data, error } = await supabase.rpc('rpc_home_alert_pref_set', { p_household: householdId, p: p as Json });
  if (error) throw error;
  return data as unknown as AlertPref;
}

// ── Commands ──────────────────────────────────────────────────────────────────
export async function sendHomeCommand(entity: string, action: HomeAction, args: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_home_command', { p_entity: entity, p_action: action, p_args: args as Json });
  if (error) throw error;
  return data as string;
}

export type CommandOutcome = 'done' | 'failed' | 'expired' | 'timeout';

/** Polls a command until the bridge answers or `timeoutMs` passes ("Home Assistant didn't answer"). */
export async function waitForHomeCommand(id: string, timeoutMs = 6000, everyMs = 400): Promise<{ outcome: CommandOutcome; error?: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    const { data } = await supabase.from('home_command').select('status, error').eq('id', id).maybeSingle();
    const row = data as { status: string; error: string | null } | null;
    if (row?.status === 'done' || row?.status === 'failed' || row?.status === 'expired') {
      return { outcome: row.status, ...(row.error ? { error: row.error } : {}) };
    }
  }
  return { outcome: 'timeout' };
}

