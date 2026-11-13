// Quick spend's engine: the screen's data (one read, kept on the phone), the waiting entries, and
// sending them — when the screen opens, when the phone is back online or back in the foreground,
// and with a growing pause in between (30 s → 5 min) while something still waits. No polling
// otherwise (log budget): one request per entry or per batch.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { outbox, type QueuedOp, type SpendOp } from '@/lib/offline';
import { EMPTY_STATE, dropEntry, mergeSent } from '@/lib/quick/merge';
import {
  deleteEntry, fetchQuickState, quickKey, saveSnapshot, type QuickState, type Snapshot,
} from '@/lib/quick/state';

export interface Identity {
  userId: string;
  householdId: string;
  role: 'owner' | 'member' | 'viewer';
  name: string | null;
  timezone: string;
}

const FIRST_RETRY = 30_000;
const MAX_RETRY = 300_000;

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

const setState = (qc: QueryClient, householdId: string, fn: (s: QuickState) => QuickState) =>
  qc.setQueryData<QuickState>(quickKey(householdId), (s) => (s ? fn(s) : s));

export function useQuick(identity: Identity, signedIn: boolean, snapshot: Snapshot | null) {
  const qc = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const ops = useSyncExternalStore(outbox.subscribe, outbox.list, outbox.list);
  const canWrite = identity.role !== 'viewer';

  const query = useQuery({
    queryKey: quickKey(identity.householdId),
    queryFn: () => fetchQuickState(identity.householdId, canWrite),
    enabled: signedIn && online,
    initialData: snapshot?.state,
    // The copy from the phone shows at once; a fresh read follows whenever there is signal.
    initialDataUpdatedAt: snapshot ? 0 : undefined,
    staleTime: 5 * 60_000,
    gcTime: Infinity,
    refetchOnWindowFocus: true,
    retry: 0,
  });
  const state = query.data ?? EMPTY_STATE;

  // Keep the copy on the phone current (also after an entry was merged in).
  useEffect(() => {
    if (!query.data) return;
    void saveSnapshot({
      v: 1, userId: identity.userId, householdId: identity.householdId, role: identity.role, name: identity.name,
      timezone: identity.timezone, savedAt: new Date(query.dataUpdatedAt || Date.now()).toISOString(),
      // Kept on the phone: tiles, account names and what was entered (amount, tile, time). Not the
      // wallet balance and not notes: those come back with the next read, when there is signal.
      state: { ...query.data, balance: null, entries: query.data.entries.map((e) => ({ ...e, notes: null })) },
    });
  }, [query.data, query.dataUpdatedAt, identity]);

  // Entries seen waiting; when one leaves the queue with an answer it joins the list (or, if Undo
  // was pressed while it was on its way, it is deleted again).
  const seen = useRef(new Map<string, SpendOp>());
  const undone = useRef(new Map<string, SpendOp>());
  const settle = useCallback(() => {
    const list = outbox.list();
    for (const o of list) if (o.kind === 'spend' && o.user_id === identity.userId) seen.current.set(o.op_id, o);
    const still = new Set(list.map((o) => o.op_id));
    for (const [id, op] of seen.current) {
      if (still.has(id)) continue;
      const r = outbox.resultOf(id) as { id: string | null } | undefined;
      if (r === undefined) continue; // being sent right now: its answer comes with the next change
      seen.current.delete(id);
      setState(qc, identity.householdId, (s) => mergeSent(s, op, r.id, identity.timezone));
      void qc.invalidateQueries({ queryKey: ['money', identity.householdId], refetchType: 'none' });
    }
    // Undo pressed while the entry was on its way: when its answer arrives after all, delete it.
    for (const [id, op] of undone.current) {
      const r = outbox.resultOf(id) as { id: string | null } | undefined;
      if (r === undefined) continue;
      undone.current.delete(id);
      if (r.id) void deleteEntry(r.id).catch(() => setState(qc, identity.householdId, (s) => mergeSent(s, op, r.id, identity.timezone)));
    }
  }, [qc, identity]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let delay = FIRST_RETRY;
    const run = async () => {
      window.clearTimeout(timer);
      const report = await outbox.flush().catch(() => null);
      if (!alive) return;
      settle();
      const waiting = outbox.list().some((o) => o.state === 'queued');
      // Only a network trouble is retried by the clock; entries held for a sign-in wait for the sign-in.
      if (waiting && navigator.onLine && report?.stoppedBy) {
        timer = window.setTimeout(() => void run(), delay);
        delay = Math.min(delay * 2, MAX_RETRY);
      } else {
        delay = FIRST_RETRY;
      }
    };
    const unsubscribe = outbox.subscribe(settle);
    void outbox.init().then(run);
    const onVisible = () => document.visibilityState === 'visible' && void run();
    const onOnline = () => void run();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [settle, signedIn]);

  const mine = useMemo(
    () => ops.filter((o): o is SpendOp => o.kind === 'spend' && o.user_id === identity.userId),
    [ops, identity.userId],
  );
  const others = useMemo(() => ops.filter((o: QueuedOp) => o.kind === 'spend' && o.user_id !== identity.userId).length, [ops, identity.userId]);

  /** Queue an entry: it shows as saved at once and is sent now or when it can be. */
  const add = useCallback(
    async (op: SpendOp) => {
      seen.current.set(op.op_id, op);
      const out = await outbox.submit(op);
      settle();
      return out;
    },
    [settle],
  );

  /** Undo or delete: before it was sent it simply leaves the queue; afterwards the money RPC deletes it. */
  const remove = useCallback(
    async (opId: string) => {
      if (await outbox.remove(opId)) {
        const op = seen.current.get(opId);
        seen.current.delete(opId);
        if (op) undone.current.set(opId, op);
        return;
      }
      const sent = outbox.resultOf(opId) as { id: string | null } | undefined;
      const txId = sent?.id ?? qc.getQueryData<QuickState>(quickKey(identity.householdId))?.entries.find((e) => e.op_id === opId)?.id;
      seen.current.delete(opId);
      if (!txId) return;
      await deleteEntry(txId);
      setState(qc, identity.householdId, (s) => dropEntry(s, opId));
      void qc.invalidateQueries({ queryKey: ['money', identity.householdId], refetchType: 'none' });
    },
    [qc, identity.householdId],
  );

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: quickKey(identity.householdId) }), [qc, identity.householdId]);
  const patch = useCallback((fn: (s: QuickState) => QuickState) => setState(qc, identity.householdId, fn), [qc, identity.householdId]);

  return { state, loading: query.isPending && query.fetchStatus !== 'idle', error: query.error, online, mine, others, add, remove, refresh, patch };
}
