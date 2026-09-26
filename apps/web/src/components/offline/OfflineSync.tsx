// Drives the offline outbox (lib/offline): loads it at start, sends it when the phone comes back
// online / to the foreground / every 30 s while something waits, refreshes what changed, and tells
// the person what happened to ops that had to wait. Also the offline banner and the "Couldn't sync"
// list (parked ops: the other phone got there first).
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { attentionKey } from '@/lib/insights/queries';
import { newOpBase, outbox, type QueuedOp, type StockOp } from '@/lib/offline';
import { invalidatePantry, pantryErrorKey } from '@/lib/pantry/queries';
import { invalidateShopping } from '@/lib/spine/queries';

const RETRY_MS = 30_000;

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

export function useOutbox(): readonly QueuedOp[] {
  return useSyncExternalStore(outbox.subscribe, outbox.list, outbox.list);
}

/** Mount once inside the signed-in shell. */
export function OfflineSync({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const online = useOnline();
  const ops = useOutbox();
  const waiting = ops.some((o) => o.state === 'queued');

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const report = await outbox.flush();
      if (!alive) return;
      if (report.sent.length) {
        void Promise.all([
          invalidatePantry(qc, householdId),
          invalidateShopping(qc, householdId),
          qc.invalidateQueries({ queryKey: attentionKey(householdId) }),
        ]);
        const stale = report.sent.filter((o) => o.kind === 'tick' && report.results.get(o.op_id) === 'stale').length;
        toast.success(t('offline.synced', { count: report.sent.length }), {
          description: stale ? t('offline.staleTicks', { count: stale }) : undefined,
        });
      }
      if (report.parked.length) {
        toast.warning(t('offline.parked', { count: report.parked.length }), {
          action: { label: t('offline.review'), onClick: () => document.getElementById('couldnt-sync')?.scrollIntoView() },
        });
      }
    };
    void outbox.init().then(run);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [qc, householdId, t]);

  // Retry while something waits and the phone claims to be online (flaky networks).
  useEffect(() => {
    if (!waiting || !online) return;
    const id = window.setInterval(() => void outbox.flush(), RETRY_MS);
    return () => window.clearInterval(id);
  }, [waiting, online]);

  return null;
}

/** A thin strip under the header while offline or while actions wait to sync. */
export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  const ops = useOutbox();
  const queued = ops.filter((o) => o.state === 'queued').length;
  const [busy, setBusy] = useState(false);
  if (online && queued === 0) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="mb-4 flex items-center gap-2.5 rounded-2xl border border-line-2 bg-white/[0.04] px-3.5 py-2.5 text-[13.5px]"
    >
      <CloudOff className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
      <span className="flex-1">
        {online ? t('offline.waiting', { count: queued }) : t('offline.banner')}
        {!online && queued > 0 && <span className="tabular text-muted"> · {t('offline.queuedCount', { count: queued })}</span>}
      </span>
      {online && queued > 0 && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void outbox.flush().finally(() => setBusy(false));
          }}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('offline.syncNow')}
        </Button>
      )}
    </div>
  );
}

/** "Use what's left": the same action for whatever there is now, with a NEW op id. */
export function withWhatsLeft(op: StockOp): StockOp | null {
  if (op.action === 'open') return null;
  if (op.error?.code !== 'GDSTK' || op.error.available === 0) return null;
  const payload: Record<string, unknown> = { ...op.payload, qty: undefined, unit_id: undefined };
  if (op.action === 'consume') payload.all = true;
  return { ...op, ...newOpBase(op.household_id, op.label), payload };
}

/** Parked ops on the Pantry page: the database refused them when they finally synced. */
export function CouldntSync({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const parked = useOutbox().filter((o) => o.state === 'parked' && o.household_id === householdId);
  if (!parked.length) return null;

  async function retryLeft(op: StockOp, again: StockOp) {
    await outbox.remove(op.op_id);
    const out = await outbox.submit(again);
    if (out.status === 'refused') toast.error(t(`pantry.errors.${pantryErrorKey(out.error)}`));
    await invalidatePantry(qc, householdId);
  }

  return (
    <Card id="couldnt-sync" className="flex flex-col gap-3 border-caution/40 p-4" data-testid="couldnt-sync">
      <div>
        <h2 className="font-display text-[17px] font-semibold">{t('offline.couldntSync')}</h2>
        <p className="text-[13px] text-muted">{t('offline.couldntSyncHint')}</p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {parked.map((op) => {
          const left = op.kind === 'stock' ? withWhatsLeft(op) : null;
          return (
            <li key={op.op_id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{op.label || t('offline.anAction')}</div>
                <div className="text-[12.5px] text-caution">
                  {op.error ? t(`pantry.errors.${pantryErrorKey(op.error)}`) : ''}
                </div>
              </div>
              {left && op.kind === 'stock' && (
                <Button size="sm" onClick={() => void retryLeft(op, left)}>
                  {t('offline.useWhatsLeft')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void outbox.remove(op.op_id)}>
                {t('offline.discard')}
              </Button>
            </li>
          );
        })}
      </ul>
      <Link to="/pantry/journal" className="self-start text-[13px] text-accent-b">
        {t('offline.seeJournal')}
      </Link>
    </Card>
  );
}
