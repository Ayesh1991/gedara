// Offline outbox (MASTER_PLAN §9 Phase 7): stock actions (use / open / move / waste) and shopping
// ticks are queued on the device and sent in order. Every op gets its id when the button is tapped
// (`crypto.randomUUID()`), and the database remembers ids it has done (`rpc_stock_op`, migration 50),
// so sending the same op twice — a retry after a timeout, a replay after a reload — never takes the
// stock twice. Ticks are naturally idempotent and "newest change wins" (`rpc_shopping_tick`).
//
// Outcomes of a send:
//   ok         → removed from the queue
//   transient  → no network, timeout, auth refresh … : stays queued, flushing stops (order!)
//   refused    → the database said no (not enough stock, lot gone …). An op sent the moment it was
//                tapped (online) is dropped and the error shown right away, like before; an op that
//                had to wait is PARKED for the person to decide ("Use what's left" / "Discard").
// Pure logic with injectable storage + sender, so it is unit-tested without IndexedDB or network.

export type StockAction = 'consume' | 'open' | 'transfer';

export interface OpError {
  code: string;
  message: string;
  /** GDSTK: how much there actually was (stock units). */
  available: number | null;
}

interface OpBase {
  op_id: string;
  household_id: string;
  /** When it was tapped (ISO). */
  client_at: string;
  /** What the person saw, e.g. "Milk −1 pcs" (for the queue and "Couldn't sync" lists). */
  label: string;
  state: 'queued' | 'parked';
  /** Sent the moment it was tapped and not yet held back by the network. */
  immediate: boolean;
  error?: OpError;
}
export interface StockOp extends OpBase {
  kind: 'stock';
  action: StockAction;
  payload: Record<string, unknown>;
}
export interface TickOp extends OpBase {
  kind: 'tick';
  item_id: string;
  done: boolean;
}
export type QueuedOp = StockOp | TickOp;

export type SendResult =
  | { type: 'ok'; result: unknown }
  | { type: 'refused'; error: OpError }
  | { type: 'transient'; message: string };

export type Outcome =
  | { status: 'done'; result: unknown }
  | { status: 'queued' }
  | { status: 'refused'; error: OpError };

export interface OutboxStorage {
  load(): Promise<QueuedOp[]>;
  /** Atomic read-modify-write (one IndexedDB transaction), so two tabs can't lose each other's ops. */
  update(fn: (ops: QueuedOp[]) => QueuedOp[]): Promise<QueuedOp[]>;
}

export interface FlushReport {
  sent: QueuedOp[];
  parked: QueuedOp[];
  /** Results of the ops that went through, by op id (ticks: 'applied' | 'same' | 'stale' | 'gone'). */
  results: Map<string, unknown>;
  stoppedBy: string | null;
}

export interface Outbox {
  submit(op: QueuedOp): Promise<Outcome>;
  flush(): Promise<FlushReport>;
  /** Remove a queued or parked op (Undo before it synced, or "Discard"). True when it was still there. */
  remove(opId: string): Promise<boolean>;
  list(): QueuedOp[];
  /** The result of an op that synced in this session (for Undo after a late sync). */
  resultOf(opId: string): unknown;
  subscribe(listener: () => void): () => void;
  /** Load the persisted queue into memory (call once at start). */
  init(): Promise<void>;
}

export function newOpBase(householdId: string, label: string, now: Date = new Date()) {
  return {
    op_id: crypto.randomUUID(),
    household_id: householdId,
    client_at: now.toISOString(),
    label,
    state: 'queued' as const,
    immediate: false,
  };
}

export function createOutbox(deps: {
  storage: OutboxStorage;
  send: (op: QueuedOp) => Promise<SendResult>;
  online: () => boolean;
  /** Serialise flushing across tabs (Web Locks); default runs directly. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Outbox {
  let ops: QueuedOp[] = [];
  const listeners = new Set<() => void>();
  const settled = new Map<string, SendResult>();
  const done = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = deps.withLock ?? (<T,>(fn: () => Promise<T>) => fn());

  const emit = () => listeners.forEach((l) => l());
  const write = async (fn: (ops: QueuedOp[]) => QueuedOp[]) => {
    ops = await deps.storage.update(fn);
    emit();
  };

  // Held back by the network: every op still queued is now a waiting op — including ones tapped
  // "online" that never got their turn — so a later refusal parks it instead of dropping it.
  const holdBack = () => write((q) => q.map((o) => (o.state === 'queued' && o.immediate ? { ...o, immediate: false } : o)));

  async function runOnce(): Promise<FlushReport> {
    const report: FlushReport = { sent: [], parked: [], results: new Map(), stoppedBy: null };
    const tried = new Set<string>();
    for (;;) {
      // Re-read every step: another tab may have sent or added ops meanwhile.
      ops = await deps.storage.load();
      const op = ops.find((o) => o.state === 'queued' && !tried.has(o.op_id));
      if (!op) break;
      tried.add(op.op_id);
      if (!deps.online()) {
        await holdBack();
        report.stoppedBy = 'offline';
        break;
      }
      const r = await deps.send(op);
      settled.set(op.op_id, r);
      if (r.type === 'ok') {
        await write((q) => q.filter((o) => o.op_id !== op.op_id));
        report.sent.push(op);
        report.results.set(op.op_id, r.result);
        done.set(op.op_id, r.result);
        if (done.size > 100) done.delete(done.keys().next().value!);
      } else if (r.type === 'refused') {
        if (op.immediate) {
          await write((q) => q.filter((o) => o.op_id !== op.op_id));
        } else {
          const parked: QueuedOp = { ...op, state: 'parked', error: r.error };
          await write((q) => q.map((o) => (o.op_id === op.op_id ? parked : o)));
          report.parked.push(parked);
        }
      } else {
        await holdBack();
        report.stoppedBy = r.message;
        break;
      }
    }
    emit();
    return report;
  }

  const flush = () => {
    const next = chain.then(() => withLock(runOnce));
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    async init() {
      ops = await deps.storage.load();
      emit();
    },
    async submit(op) {
      const online = deps.online();
      await write((q) => [...q, { ...op, state: 'queued', immediate: online }]);
      if (!online) return { status: 'queued' };
      await flush();
      const r = settled.get(op.op_id);
      settled.delete(op.op_id);
      if (r?.type === 'ok') return { status: 'done', result: r.result };
      if (r?.type === 'refused' && !ops.some((o) => o.op_id === op.op_id)) return { status: 'refused', error: r.error };
      return { status: 'queued' };
    },
    flush,
    async remove(opId) {
      let found = false;
      await write((q) => {
        found = q.some((o) => o.op_id === opId);
        return q.filter((o) => o.op_id !== opId);
      });
      return found;
    },
    list: () => ops,
    resultOf: (opId) => done.get(opId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A Postgres SQLSTATE (5 chars: 42501, 23503, GDSTK …) is the database refusing; anything else
 *  (network, timeout, PostgREST PGRST…, auth) is transient and the op waits. */
export function classifyError(e: unknown): SendResult {
  const err = (e ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : String(e);
  if (/^[0-9A-Z]{5}$/.test(code)) {
    const n = typeof err.details === 'string' ? Number(err.details) : NaN;
    return { type: 'refused', error: { code, message, available: Number.isFinite(n) ? n : null } };
  }
  return { type: 'transient', message: message || 'network' };
}
