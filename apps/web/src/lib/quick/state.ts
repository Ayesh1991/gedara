// Quick spend (Phase 12) data: ONE read for the whole screen (rpc_quick_state), a copy of it kept
// on the phone so the screen opens with no signal, and the few writes that are not entries (tiles,
// settings). Entries themselves go through the outbox (lib/offline) → rpc_quick_spend.
import { createStore, del, get, set } from 'idb-keyval';
import { supabase } from '../supabase';
import { SnapshotSchema, StateSchema, type Prefs, type QuickState, type Snapshot } from './schema';

export * from './schema';

export const quickKey = (householdId: string) => ['quick', householdId] as const;

/** The whole screen in one request; sets the person up first when this is their first time. */
export async function fetchQuickState(householdId: string, canWrite: boolean): Promise<QuickState> {
  const read = async () => {
    const { data, error } = await supabase.rpc('rpc_quick_state', { p_household: householdId });
    if (error) throw error;
    return StateSchema.parse(data);
  };
  let state = await read();
  if (canWrite && (!state.prefs || state.tiles.length === 0)) {
    const { error } = await supabase.rpc('rpc_quick_setup', { p_household: householdId });
    if (error) throw error;
    state = await read();
  }
  return state;
}

// ── The copy kept on the phone ──────────────────────────────────────────────────────────────────
// Who the person is, their wallet, tiles and recent entries: enough to enter with no signal and
// with an expired login. No tokens, nothing secret. Removed on an explicit sign-out.

const KEY = 'quick-snapshot';
let store: ReturnType<typeof createStore> | null = null;
const idb = () => (store ??= createStore('gedara-quick', 'kv'));

export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    const parsed = SnapshotSchema.safeParse(await get(KEY, idb()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  try {
    await set(KEY, s, idb());
  } catch {
    // no IndexedDB: Quick spend then needs the network to open
  }
}

export async function clearSnapshot(): Promise<void> {
  try {
    await del(KEY, idb());
  } catch {
    // nothing to clear
  }
}

// ── Tiles and settings (plain RLS writes: a person changes only their own) ──────────────────────

export interface TileInput {
  label: string | null;
  icon: string | null;
  category_id: string | null;
  usual_amount: number | null;
}

export async function addTile(householdId: string, input: TileInput & { label: string }, sort: number) {
  const { error } = await supabase.from('quick_tile').insert({ household_id: householdId, ...input, sort });
  if (error) throw error;
}

export async function updateTile(id: string, patch: Partial<TileInput & { hidden: boolean; sort: number }>) {
  const { error } = await supabase.from('quick_tile').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteTile(id: string) {
  const { error } = await supabase.from('quick_tile').delete().eq('id', id);
  if (error) throw error;
}

/** The person's own order: every tile gets its place in the list (two requests at most: changed rows only). */
export async function saveOrder(tiles: Array<{ id: string; sort: number }>, orderedIds: string[]) {
  const changed = orderedIds.map((id, i) => ({ id, sort: i + 1 })).filter((n) => tiles.find((t) => t.id === n.id)?.sort !== n.sort);
  await Promise.all(changed.map((c) => updateTile(c.id, { sort: c.sort })));
}

export async function updatePrefs(householdId: string, userId: string, patch: Partial<Prefs>) {
  const { error } = await supabase.from('quick_prefs').update(patch).eq('household_id', householdId).eq('user_id', userId);
  if (error) throw error;
}

// ── Speed (the "five seconds"): the last real figures of this phone, shown on Diagnostics ───────

const PERF_KEY = 'gedara:quick-perf';
export interface QuickPerf {
  /** ms from the page starting to load until the pad could be used (only when Quick spend was the first screen). */
  readyMs: number | null;
  /** ms from the pad being ready until the entry showed as saved. */
  savedMs: number | null;
  at: string;
}

export function readPerf(): QuickPerf | null {
  try {
    return JSON.parse(localStorage.getItem(PERF_KEY) ?? 'null') as QuickPerf | null;
  } catch {
    return null;
  }
}

export function writePerf(patch: Partial<QuickPerf>) {
  try {
    const now = { readyMs: null, savedMs: null, ...readPerf(), ...patch, at: new Date().toISOString() };
    localStorage.setItem(PERF_KEY, JSON.stringify(now));
  } catch {
    // storage blocked
  }
}

/** Undo / delete of a sent entry: the ordinary money RPC (rule 1). */
export async function deleteEntry(transactionId: string) {
  const { error } = await supabase.rpc('rpc_delete_transaction', { p_id: transactionId, p_keep_stock: false });
  if (error) throw error;
}

let readyAt: number | null = null;

/** The pad can be used (once per page load). */
export function markReady() {
  if (readyAt !== null) return;
  readyAt = performance.now();
  performance.mark('quick:ready');
  const nav = performance.getEntriesByType('navigation')[0];
  // Only when Quick spend was the first screen (opened from its icon) is this the real start-up time.
  if (nav && new URL(nav.name).pathname.startsWith('/quick')) writePerf({ readyMs: Math.round(readyAt) });
}

/** An entry showed as saved. */
export function markSaved() {
  performance.mark('quick:saved');
  if (readyAt !== null) writePerf({ savedMs: Math.round(performance.now() - readyAt) });
}
