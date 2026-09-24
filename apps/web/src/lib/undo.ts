// Undo for deletes (MASTER_PLAN §5.4): the item disappears at once, the delete is only sent after
// 8 s. If the app goes to the background first, pending deletes are committed right away.
// (Places keeps its own copy of this in lib/places.ts; new features use this one.)

export const UNDO_MS = 8000;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>();

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const p of [...pending.values()]) p.commit();
  });
}

export function isPendingDelete(id: string): boolean {
  return pending.has(id);
}

/**
 * Hide now, delete after the Undo window. `hide` removes it from what's on screen; `commit`
 * performs the delete; `restore` brings it back (usually a refetch).
 */
export function scheduleUndoableDelete(opts: {
  id: string;
  hide: () => void;
  commit: () => Promise<unknown>;
  restore: () => void;
  onError: (e: unknown) => void;
  ms?: number;
}): { undo: () => void; ms: number } {
  const ms = opts.ms ?? UNDO_MS;
  opts.hide();
  const commit = () => {
    const p = pending.get(opts.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(opts.id);
    opts.commit().catch(opts.onError).finally(opts.restore);
  };
  pending.set(opts.id, { timer: setTimeout(commit, ms), commit });
  return {
    ms,
    undo: () => {
      const p = pending.get(opts.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(opts.id);
      opts.restore();
    },
  };
}
