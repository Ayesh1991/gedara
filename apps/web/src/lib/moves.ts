// Put a thing or a place into a place (Phase 7b, migration 58). Like stock actions, every move gets
// its op id at tap time and goes through the outbox, so it works offline and a replay never moves
// twice. A move queued offline whose item was moved again since is parked (GDMVC) — "Move anyway"
// sends it again with `force`. Products move their stock with `transfer` (lib/pantry/queries).
import { newOpBase, outbox, type MoveOp } from './offline';

export { moveErrorKey, type MoveError } from './moveErrors';

export type MoveItem = 'asset' | 'location';

export interface MoveResult {
  op_id: string;
  from: string | null;
  to: string | null;
  /** Saved on the device: it syncs later; Undo = take it out of the queue. */
  queued: boolean;
}

export function moveOp(
  householdId: string,
  item: MoveItem,
  itemId: string,
  to: string | null,
  label: string,
  extra: Pick<MoveOp, 'force' | 'expect_from'> = {},
): MoveOp {
  return { ...newOpBase(householdId, label), kind: 'move', item, item_id: itemId, to, ...extra };
}

/** Sends (or queues) a move; a refusal while online throws the database error. */
export async function submitMove(op: MoveOp): Promise<MoveResult> {
  const out = await outbox.submit(op);
  if (out.status === 'queued') return { op_id: op.op_id, from: null, to: op.to, queued: true };
  if (out.status === 'refused') {
    throw Object.assign(new Error(out.error.message), { code: out.error.code, details: out.error.detail });
  }
  const r = (out.result ?? {}) as { from?: string | null; to?: string | null };
  return { op_id: op.op_id, from: r.from ?? null, to: r.to ?? op.to, queued: false };
}

export const moveItem = (
  householdId: string,
  item: MoveItem,
  itemId: string,
  to: string | null,
  label: string,
  extra?: Pick<MoveOp, 'force' | 'expect_from'>,
) => submitMove(moveOp(householdId, item, itemId, to, label, extra));

/**
 * Undo a move: take it out of the queue if it hasn't synced, otherwise move the item back — only
 * while it is still where the move put it (another phone may have moved it since).
 */
export async function undoMove(householdId: string, item: MoveItem, itemId: string, done: MoveResult, label: string) {
  if (done.queued && (await outbox.remove(done.op_id))) return;
  const synced = done.queued ? (outbox.resultOf(done.op_id) as { from?: string | null } | undefined) : done;
  if (!synced) return;
  await moveItem(householdId, item, itemId, synced.from ?? null, label, { expect_from: done.to });
}
