// House (Phase 8): Home Assistant's rooms, as the bridge on the Gedara Pi reports them. At the top
// one line says what matters ("Everything closed" / "2 open: …", lights on, the AC); below, one
// card per Home Assistant area with its AC, switches, lights, doors and windows. Owner and members
// can switch what the owner made controllable; a viewer only looks. No notifications here: Home
// Assistant sends its own.
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { CircleCheck, HousePlug, TriangleAlert, WifiOff } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/aurora/EmptyState';
import { RoomCard } from '@/components/home/RoomCard';
import { useHomeControl } from '@/components/home/useHomeControl';
import { useHomeLive } from '@/components/home/useHomeLive';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { bridgeOnline, bridgeQuery, displayName, entitiesQuery, roomsOf, summaryOf } from '@/lib/home/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/house')({
  component: HousePage,
});

function HousePage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const bridge = useQuery(bridgeQuery(householdId));
  const entities = useQuery({ ...entitiesQuery(householdId), enabled: !!bridge.data });
  useHomeLive(householdId, !!bridge.data);
  const { act, busy } = useHomeControl(householdId);

  const collator = useMemo(() => new Intl.Collator(locale), [locale]);
  const rooms = useMemo(() => roomsOf(entities.data ?? [], collator), [entities.data, collator]);
  const summary = useMemo(() => summaryOf(entities.data ?? []), [entities.data]);
  const fmt = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: timezone });
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
    return (iso: string) => (Date.now() - Date.parse(iso) < 20 * 3600_000 ? time : day).format(new Date(iso));
  }, [locale, timezone]);

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="flex-1 font-display text-[30px] font-semibold tracking-tight">{t('house.title')}</h1>
      {bridge.data && (
        <span className="glass flex h-10 min-w-0 items-center gap-2 rounded-full px-3.5 text-[13.5px]">
          <span
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', bridgeOnline(bridge.data) ? 'bg-teal shadow-[0_0_10px_var(--teal)]' : 'bg-caution')}
            aria-hidden
          />
          <span className="truncate">{bridgeOnline(bridge.data) ? t('house.bridge.online') : t('house.bridge.offline')}</span>
        </span>
      )}
    </div>
  );

  if (bridge.isPending) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="glass h-40 animate-pulse rounded-[28px] motion-reduce:animate-none" aria-hidden />
      </div>
    );
  }

  if (!bridge.data) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <EmptyState
          icon={HousePlug}
          title={t('house.empty.title')}
          body={t(membership.role === 'owner' ? 'house.empty.bodyOwner' : 'house.empty.body')}
          action={
            membership.role === 'owner' ? (
              <Link to="/settings/devices" className={buttonVariants({ variant: 'accent' })}>
                {t('house.empty.action')}
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  const online = bridgeOnline(bridge.data);
  const ha = bridge.data.status?.ha;
  const open = summary.open;

  return (
    <div className="flex flex-col gap-5">
      {header}

      {!online ? (
        <Card className="flex items-center gap-3 border-caution/40 py-3.5 text-[14px]" role="status">
          <WifiOff className="h-5 w-5 shrink-0 text-caution" aria-hidden />
          <span className="text-[#c9d0e6]">
            {t('house.bridge.offlineBody', { when: bridge.data.last_seen_at ? fmt(bridge.data.last_seen_at) : t('house.bridge.never') })}
          </span>
        </Card>
      ) : ha && ha !== 'connected' ? (
        <Card className="flex items-center gap-3 border-caution/40 py-3.5 text-[14px]" role="status">
          <TriangleAlert className="h-5 w-5 shrink-0 text-caution" aria-hidden />
          <span className="text-[#c9d0e6]">{t(`house.bridge.ha.${ha}`)}</span>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2" data-testid="house-summary">
        <div className="flex items-center gap-3">
          {open.length ? (
            <TriangleAlert className="h-6 w-6 shrink-0 text-caution" aria-hidden />
          ) : (
            <CircleCheck className="h-6 w-6 shrink-0 text-teal" aria-hidden />
          )}
          <p className={cn('min-w-0 flex-1 font-display text-[18px] font-semibold', open.length ? 'text-caution' : 'text-text')}>
            {open.length
              ? t('house.summary.open', { count: open.length, names: open.slice(0, 3).map(displayName).join(', ') + (open.length > 3 ? '…' : '') })
              : t('house.summary.closed')}
          </p>
        </div>
        <p className="tabular text-[13.5px] text-muted">
          {[
            summary.lights > 0 && (summary.lightsOn ? t('house.summary.lights', { count: summary.lightsOn }) : t('house.summary.lightsOff')),
            summary.ac &&
              (summary.ac.state && summary.ac.state !== 'off' && summary.ac.state !== 'unavailable'
                ? t('house.summary.acOn', { mode: t(`house.mode.${summary.ac.state}`, { defaultValue: summary.ac.state }), t: summary.ac.attrs.temperature ?? '—' })
                : t('house.summary.acOff')),
            summary.unavailable > 0 && t('house.summary.unavailable', { count: summary.unavailable }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </Card>

      {rooms.length === 0 ? (
        <Card className="text-[14px] text-muted">{t(entities.isPending ? 'house.loading' : 'house.nothingShown')}</Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((r) => (
            <RoomCard key={r.name ?? '—'} room={r} canWrite={canWrite} act={act} busy={busy} time={fmt} />
          ))}
        </div>
      )}

      {membership.role === 'owner' && (
        <Link to="/settings/home-assistant" className="self-start text-[14px] text-muted underline-offset-4 hover:text-text hover:underline">
          {t('house.choose')}
        </Link>
      )}
    </div>
  );
}
