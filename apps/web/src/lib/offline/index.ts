// The app's outbox: IndexedDB storage + Supabase sender (see ./outbox for the rules).
import { createStore, get, update } from 'idb-keyval';
import type { Json } from '../db.types';
import { supabase } from '../supabase';
import { classifyError, createOutbox, type OutboxStorage, type QueuedOp, type SendResult } from './outbox';

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

async function send(op: QueuedOp): Promise<SendResult> {
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
  online: () => typeof navigator === 'undefined' || navigator.onLine,
  withLock,
});
