// The app's outbox: IndexedDB storage + Supabase sender (see ./outbox for the rules).
import { createStore, get, update } from 'idb-keyval';
import type { Json } from '../db.types';
import { supabase } from '../supabase';
import { classifyError, createOutbox, type OutboxStorage, type QueuedOp, type SendResult, type SpendOp } from './outbox';

export * from './outbox';

const SEND_TIMEOUT_MS = 15_000;
const KEY = 'outbox';

let store: ReturnType<typeof createStore> | null = null;
const idb = () => (store ??= createStore('gedara-offline', 'kv'));

// IndexedDB can be missing (old Safari private mode): fall back to memory so the app still works.
let memory: QueuedOp[] = [];
const storage: OutboxStorage = {
  async load() {
    try {
      return (await get<QueuedOp[]>(KEY, idb())) ?? [];
    } catch {
      return memory;
    }
  },
  async update(fn) {
    try {
      let next: QueuedOp[] = [];
      await update<QueuedOp[]>(KEY, (old) => (next = fn(old ?? [])), idb());
      return next;
    } catch {
      memory = fn(memory);
      return memory;
    }
  },
};

/** Who is signed in on this device right now (no network: the saved session). */
async function signedInUser(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

interface SpendAnswer {
  op_id: string;
  status: 'saved' | 'replayed' | 'refused';
  id?: string | null;
  fingerprint?: string;
  code?: string;
  message?: string;
}

/**
 * Quick spend (Phase 12): all waiting entries of one person in ONE request. Nothing is sent unless
 * that person is signed in: the entries are held (not lost, not refused) until they sign in.
 */
async function sendSpends(ops: SpendOp[]): Promise<SendResult[]> {
  const head = ops[0];
  if (!head) return [];
  const all = (r: SendResult) => ops.map(() => r);
  const user = await signedInUser();
  if (user !== head.user_id) return all({ type: 'hold', reason: user ? 'other-user' : 'signed-out' });
  try {
    const { data, error } = await supabase
      .rpc('rpc_quick_spend', {
        p_household: head.household_id,
        p_ops: ops.map((o) => ({
          op_id: o.op_id,
          kind: o.entry,
          tile_id: o.tile_id,
          label: o.name,
          category_id: o.category_id,
          amount: o.amount,
          account_id: o.account_id,
          to_account_id: o.to_account_id ?? null,
          client_at: o.client_at,
          fingerprint: o.fingerprint,
          line_tail: o.line_tail,
          note: o.note ?? null,
        })) as unknown as Json,
      })
      .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS));
    if (error) {
      // The whole call refused (42501: signed in but not allowed to write) parks each entry for
      // the person to see; anything else (network, an expired login) leaves them waiting.
      const r = classifyError(error);
      return all(r.type === 'refused' && r.error.code !== '42501' ? { type: 'transient', message: r.error.message } : r);
    }
    const byId = new Map(((data ?? []) as unknown as SpendAnswer[]).map((a) => [a.op_id, a]));
    return ops.map((o): SendResult => {
      const a = byId.get(o.op_id);
      if (!a) return { type: 'transient', message: 'no answer' };
      if (a.status === 'refused') {
        return { type: 'refused', error: { code: a.code ?? 'XX000', message: a.message ?? '', available: null } };
      }
      return { type: 'ok', result: { id: a.id ?? null, replayed: a.status === 'replayed', fingerprint: a.fingerprint } };
    });
  } catch (e) {
    return all({ type: 'transient', message: e instanceof Error ? e.message : 'network' });
  }
}

async function send(op: QueuedOp): Promise<SendResult> {
  if (op.kind === 'spend') return (await sendSpends([op]))[0]!;
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  try {
    if (op.kind === 'stock') {
      const body = Object.fromEntries(Object.entries(op.payload).filter(([, v]) => v !== undefined));
      const { data, error } = await supabase
        .rpc('rpc_stock_op', {
          p_op_id: op.op_id,
          p_action: op.action,
          p: body as Json,
          // Only an op that waited carries its tap time; one sent at once is "now".
          p_client_at: op.immediate ? undefined : op.client_at,
        })
        .abortSignal(signal);
      if (error) return classifyError(error);
      return { type: 'ok', result: data };
    }
    if (op.kind === 'move') {
      const { data, error } = await supabase
        .rpc('rpc_move', {
          p_op_id: op.op_id,
          p_kind: op.item,
          p_id: op.item_id,
          // PostgREST needs the key present to pick the function; null = no place.
          p_to: op.to as string,
          p_client_at: op.immediate ? undefined : op.client_at,
          p_force: op.force ?? false,
          p_expect: op.expect_from === undefined ? undefined : ({ from: op.expect_from } as Json),
        })
        .abortSignal(signal);
      if (error) return classifyError(error);
      return { type: 'ok', result: data };
    }
    const { data, error } = await supabase
      .rpc('rpc_shopping_tick', { p_item: op.item_id, p_done: op.done, p_at: op.immediate ? undefined : op.client_at })
      .abortSignal(signal);
    if (error) return classifyError(error);
    return { type: 'ok', result: data };
  } catch (e) {
    return { type: 'transient', message: e instanceof Error ? e.message : 'network' };
  }
}

const withLock = <T,>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks.request('gedara-outbox', fn) as Promise<T>)
    : fn();

export const outbox = createOutbox({
  storage,
  send,
  sendSpends,
  online: () => typeof navigator === 'undefined' || navigator.onLine,
  withLock,
});
