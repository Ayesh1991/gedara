// Pantry › Kitchen scale (Phase 6b): the iPad on the counter. Shows what the scale is doing right now
// (live state over Realtime), the last result big ("Sugar −24 g · 788 g left", with how long it took
// to arrive), open questions, and the latest readings. Can keep the screen awake.
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, Lightbulb, Scale, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/aurora/EmptyState';
import { ReadingCard } from '@/components/scale/ReadingCard';
import { popupsEnabled, setPopupsEnabled } from '@/components/scale/ScalePopups';
import { useScaleLive } from '@/components/scale/useScaleLive';
import { Card } from '@/components/ui/card';
import { deviceOnline, formatGrams } from '@/lib/scale/format';
import { openReadingsQuery, readingsQuery, scalesQuery, type ScaleDevice, type ScaleReading } from '@/lib/scale/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/pantry/scale')({
  component: KitchenScalePage,
});

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Screen Wake Lock while asked for (re-taken when the page becomes visible again). */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const take = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(
        (l) => (lock = l),
        () => undefined,
      );
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      document.removeEventListener('visibilitychange', take);
      void lock?.release();
    };
  }, [on]);
}

function LiveState({ device, now }: { device: ScaleDevice; now: number }) {
  const { t } = useTranslation();
  const online = deviceOnline(device.last_seen_at, now);
  const state = online ? (device.live_state ?? 'empty') : 'offline';
  return (
    <div className="flex items-center gap-3" data-testid="scale-live" data-state={state}>
      <span
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-2xl border',
          online ? 'border-teal/40 text-teal' : 'border-caution/40 text-caution',
        )}
        aria-hidden
      >
        {online ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[17px] font-semibold">{device.name}</div>
        <div className="text-[13.5px] text-muted">{t(`scale.live.${state}`)}</div>
      </div>
      {online && device.live_state === 'settling' && device.live_gross_g !== null && (
        <span className="tabular text-[22px] text-muted">{formatGrams(device.live_gross_g)}</span>
      )}
    </div>
  );
}

function KitchenScalePage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const now = useNow(5000);
  const scales = useQuery(scalesQuery(householdId));
  const recent = useQuery(readingsQuery(householdId, { limit: 20 }));
  const open = useQuery(openReadingsQuery(householdId));
  const [latest, setLatest] = useState<ScaleReading | null>(null);
  const [awake, setAwake] = useState(false);
  const [popups, setPopups] = useState(popupsEnabled);
  useWakeLock(awake);

  const onReading = useCallback((r: ScaleReading, kind: 'insert' | 'update') => {
    if (kind === 'insert') setLatest(r);
    else setLatest((l) => (l && l.id === r.id ? { ...l, ...r } : l));
  }, []);
  useScaleLive(householdId, onReading);

  const active = (scales.data ?? []).filter((d) => !d.revoked_at);
  const shown = latest ?? recent.data?.[0] ?? null;
  const questions = (open.data ?? []).filter((r) => r.id !== shown?.id);
  const history = (recent.data ?? []).filter((r) => r.id !== shown?.id);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/pantry" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.pantry')}
      </Link>
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="flex-1 font-display text-[30px] font-semibold tracking-tight">{t('scale.page.title')}</h1>
        <label className="flex items-center gap-2 text-[13.5px] text-muted">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent-a)]" checked={awake} onChange={(e) => setAwake(e.target.checked)} />
          <Lightbulb className="h-4 w-4" aria-hidden />
          {t('scale.page.keepAwake')}
        </label>
        <label className="flex items-center gap-2 text-[13.5px] text-muted">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent-a)]"
            checked={popups}
            onChange={(e) => {
              setPopups(e.target.checked);
              setPopupsEnabled(e.target.checked);
            }}
          />
          {t('scale.page.popups')}
        </label>
      </div>

      {scales.isPending ? (
        <div className="glass h-28 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : active.length === 0 ? (
        <EmptyState
          icon={Scale}
          title={t('scale.page.emptyTitle')}
          body={t('scale.page.emptyBody')}
          action={
            <Link to="/settings/devices" className="text-accent-b underline">
              {t('scale.page.addScale')}
            </Link>
          }
        />
      ) : (
        <>
          <Card className="flex flex-col gap-4">
            {active.map((d) => (
              <LiveState key={d.id} device={d} now={now} />
            ))}
          </Card>

          {shown ? (
            <ReadingCard reading={shown} householdId={householdId} canWrite={canWrite} big />
          ) : (
            <Card className="text-[15px] text-muted">{t('scale.page.noReadings')}</Card>
          )}

          {questions.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <h2 className="font-display text-[19px] font-semibold">{t('scale.page.questions')}</h2>
              {questions.map((r) => (
                <ReadingCard key={r.id} reading={r} householdId={householdId} canWrite={canWrite} />
              ))}
            </section>
          )}

          {history.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <h2 className="font-display text-[19px] font-semibold">{t('scale.page.recent')}</h2>
              {history.slice(0, 12).map((r) => (
                <ReadingCard key={r.id} reading={r} householdId={householdId} canWrite={canWrite} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
