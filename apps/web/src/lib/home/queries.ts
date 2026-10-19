// Home Assistant in Gedara (Phase 8) — data access. The bridge on the Gedara Pi reports doors,
// windows, lights, switches and the AC into home_entity (RLS: members read); the owner chooses what
// shows and what may be controlled (rpc_home_entity_set), owner and members send commands
// (rpc_home_command), and the bridge carries them out through Home Assistant's own API. Nothing
// here ever sees Home Assistant's token: it stays on the Pi.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { HaState, HomeAction } from '@home/protocol';
import type { Json } from '../db.types';
import { supabase } from '../supabase';
import type { HomeEntity } from './logic';

export * from './logic';

export const homeKey = (householdId: string, ...rest: unknown[]) => ['home', householdId, ...rest] as const;

export function invalidateHome(qc: QueryClient, householdId: string, what?: 'bridge' | 'entities') {
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
  shown, controllable, changed_at, updated_at`;

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

export async function setEntity(id: string, p: { shown?: boolean; controllable?: boolean; label?: string | null }) {
  const { data, error } = await supabase.rpc('rpc_home_entity_set', { p_id: id, p: p as Json });
  if (error) throw error;
  return data as unknown as Pick<HomeEntity, 'id' | 'shown' | 'controllable' | 'label'>;
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

