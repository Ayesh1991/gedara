// Scan flows (Phase 7b): the actions behind "Put in a place", "Fill this box" and Quick add, each
// returning an Undo. Moves of things and places go through rpc_move, products move their stock with
// transfer (both via the offline outbox); creating an item is undone by deleting it again.
import type { QueryClient } from '@tanstack/react-query';
import { invalidateLabels } from '@/lib/labels/blank';
import type { TagTarget } from '@/lib/labels/tags';
import { moveItem, undoMove, type MoveItem } from '@/lib/moves';
import { outbox } from '@/lib/offline';
import { deleteProduct, invalidatePantry, transfer, undoStock } from '@/lib/pantry/queries';
import { deletePlace, invalidatePlaces } from '@/lib/places';
import { deleteAsset, invalidateThings } from '@/lib/things/queries';

export interface Done {
  /** Saved on the device; it syncs later. */
  queued: boolean;
  /** Stock moved (stock units), for products. */
  qty?: number;
  undo: () => Promise<void>;
}

async function refresh(qc: QueryClient, householdId: string, what: 'place' | 'thing' | 'stock') {
  if (what === 'stock') await invalidatePantry(qc, householdId);
  else if (what === 'thing') await invalidateThings(qc, householdId);
  await invalidatePlaces(qc, householdId);
}

/** A thing or a place into a place. */
export async function putItem(qc: QueryClient, householdId: string, item: MoveItem, id: string, to: string, label: string): Promise<Done> {
  const r = await moveItem(householdId, item, id, to, label);
  const what = item === 'asset' ? 'thing' : 'place';
  if (!r.queued) await refresh(qc, householdId, what);
  return {
    queued: r.queued,
    undo: async () => {
      await undoMove(householdId, item, id, r, label);
      await refresh(qc, householdId, what);
    },
  };
}

/** A product's stock into a place: all of it (qty omitted) or `qty` of `unitId`. Lots already there stay. */
export async function putStock(
  qc: QueryClient,
  householdId: string,
  productId: string,
  to: string,
  label: string,
  amount?: { qty: number; unitId: string | null },
): Promise<Done> {
  const r = await transfer(
    { household_id: householdId, product_id: productId, to_location_id: to, qty: amount?.qty, unit_id: amount?.unitId ?? undefined },
    label,
  );
  if (!r.queued) await invalidatePantry(qc, householdId);
  return {
    queued: Boolean(r.queued),
    qty: r.qty,
    undo: async () => {
      if (r.queued && r.op_id && (await outbox.remove(r.op_id))) return;
      const synced = r.queued && r.op_id ? (outbox.resultOf(r.op_id) as { correlation_id?: string } | undefined) : r;
      if (synced?.correlation_id) await undoStock(synced.correlation_id);
      await invalidatePantry(qc, householdId);
    },
  };
}

/** Quick add's Undo: the new item goes again (its labels become blank again with it). */
export async function deleteCreated(qc: QueryClient, householdId: string, target: TagTarget) {
  if (target.kind === 'asset') await deleteAsset(target.id);
  else if (target.kind === 'product') await deleteProduct(target.id);
  else await deletePlace(target.id);
  await Promise.all([
    target.kind === 'asset' ? invalidateThings(qc, householdId) : invalidatePantry(qc, householdId),
    invalidatePlaces(qc, householdId),
    invalidateLabels(qc, householdId),
  ]);
}
