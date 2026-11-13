// Offline outbox (MASTER_PLAN §9 Phase 7): stock actions (use / open / move / waste), shopping
// ticks and (Phase 7b) things / places put into places are queued on the device and sent in order. Every op gets its id when the button is tapped
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
  /** The database's detail text (GDMVC: 'newer' | 'moved'). */
  detail?: string;
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
/** Phase 7b: a thing or a place put into a place (`rpc_move`, idempotent by op id). */
export interface MoveOp extends OpBase {
  kind: 'move';
  item: 'asset' | 'location';
  item_id: string;
  /** Destination place; null = no place (thing) / top level (place). */
  to: string | null;
  /** "Move anyway" after it was parked because the item moved again since the tap (GDMVC). */
  force?: boolean;
  /** Undo: only move back while the item is still here (omitted = no check). */
  expect_from?: string | null;
}
/**
 * Phase 12: a Quick spend entry (`rpc_quick_spend`, counted once by op id). Only the amount, the
 * tile and the time wait on the phone. Unlike the others it is NEVER dropped (a refusal parks it
 * even when it was sent at once), it is only sent while its own person is signed in (otherwise it
 * is held and the rest of the queue goes on), and all waiting entries go in one request.
 */
export interface SpendOp extends OpBase {
  kind: 'spend';
  user_id: string;
  entry: 'expense' | 'handover';
  tile_id: string | null;
  /** The tile's name as it was shown (the line's name). */
  name: string;
  category_id: string | null;
  amount: number;
  /** null = the person's own wallet (decided by the database). */
  account_id: string | null;
  to_account_id?: string | null;
  /** Deterministic, worked out at the tap (rule 5): `m<djb2(…)>` and the line's `<djb2(name|amount)>`. */
  fingerprint: string;
  line_tail: string | null;
  note?: string | null;
}
export type QueuedOp = StockOp | TickOp | MoveOp | SpendOp;

export type SendResult =
  | { type: 'ok'; result: unknown }
  | { type: 'refused'; error: OpError }
  | { type: 'transient'; message: string }
  /** Not now, but nothing is wrong with the network (not signed in as its person): stays queued, the queue goes on. */
  | { type: 'hold'; reason: string };

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
  /** Left waiting without a network problem (Quick spend entries of someone not signed in). */
  held: QueuedOp[];
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
  /** Quick spend entries go together: one request for all that wait (same order, one result each). */
  sendSpends?: (ops: SpendOp[]) => Promise<SendResult[]>;
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
    const report: FlushReport = { sent: [], parked: [], held: [], results: new Map(), stoppedBy: null };
    const tried = new Set<string>();
    // Answers of a batch whose ops are settled one by one below.
    const pending = new Map<string, SendResult>();
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
      let r: SendResult;
      if (pending.has(op.op_id)) {
        r = pending.get(op.op_id)!;
        pending.delete(op.op_id);
      } else if (op.kind === 'spend' && deps.sendSpends) {
        // Every waiting entry of this person, oldest first, in one request (≤ 50); the others'
        // answers are kept and settled when their turn comes just below.
        const rest = ops
          .filter((o): o is SpendOp => o.kind === 'spend' && o.state === 'queued' && !tried.has(o.op_id) &&
            o.household_id === op.household_id && o.user_id === op.user_id)
          .slice(0, 49);
        const results = await deps.sendSpends([op, ...rest]);
        rest.forEach((o, i) => pending.set(o.op_id, results[i + 1] ?? { type: 'transient', message: 'no answer' }));
        r = results[0] ?? { type: 'transient', message: 'no answer' };
      } else {
        r = await deps.send(op);
      }
      settled.set(op.op_id, r);
      if (r.type === 'hold') {
        report.held.push(op);
        continue;
      }
      if (r.type === 'ok') {
        await write((q) => q.filter((o) => o.op_id !== op.op_id));
        report.sent.push(op);
        report.results.set(op.op_id, r.result);
        done.set(op.op_id, r.result);
        if (done.size > 100) done.delete(done.keys().next().value!);
      } else if (r.type === 'refused') {
        if (op.immediate && op.kind !== 'spend') {
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
    // Text details (GDMVC 'newer' …); a number is the GDSTK quantity above.
    const detail = typeof err.details === 'string' && err.details && !Number.isFinite(n) ? err.details : undefined;
    return { type: 'refused', error: { code, message, available: Number.isFinite(n) ? n : null, ...(detail ? { detail } : {}) } };
  }
  return { type: 'transient', message: message || 'network' };
}
