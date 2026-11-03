// House › Log (Phase 8b): every change Home Assistant reported for what's logged — doors and windows
// (opened → closed, how long), people detected, other binary sensors, and the sensors' values —
// with Home Assistant's own times, newest first, by day. Filters: kind, room, one day. 200 at a
// time. Nothing from the cameras ever reaches it (the bridge only sends ESPHome sensors).
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { AppWindow, ChevronLeft, DoorClosed, Gauge, PersonStanding, Power, ScrollText, Snowflake, Sun, Lightbulb, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HomeKind } from '@home/protocol';
import { EmptyState } from '@/components/aurora/EmptyState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  LOG_PAGE,
  dayRange,
  entitiesQuery,
  fetchEvents,
  homeKey,
  localDay,
  logRows,
  sensorValue,
  shortDuration,
  type LogFilter,
  type LogRow,
} from '@/lib/home/queries';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/house/log')({
  component: HouseLogPage,
});

const ICON: Record<HomeKind, LucideIcon> = {
  door: DoorClosed, window: AppWindow, presence: PersonStanding, binary: Sun, sensor: Gauge, light: Lightbulb, switch: Power, climate: Snowflake,
};
const FILTERS: LogFilter[] = ['all', 'openings', 'people', 'sensors'];

function HouseLogPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const [filter, setFilter] = useState<LogFilter>('all');
  const [room, setRoom] = useState<string | null>(null);
  const [day, setDay] = useState('');
  const entities = useQuery(entitiesQuery(householdId));
  const rooms = useMemo(
    () => [...new Set((entities.data ?? []).map((e) => e.area).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b, locale)),
    [entities.data, locale],
  );
  const range = day ? dayRange(day, timezone) : undefined;
  const key = homeKey(householdId, 'events', filter, room, day);
  const events = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchEvents(householdId, { filter, room, before: pageParam, day: range }),
    getNextPageParam: (last) => (last.length === LOG_PAGE ? last[last.length - 1]!.at : undefined),
    staleTime: 15_000,
  });

  // New changes while the page is open: one refresh a few seconds later (a burst of them is one).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`home-log-${householdId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'home_event', filter: `household_id=eq.${householdId}` }, () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          void qc.invalidateQueries({ queryKey: homeKey(householdId, 'events') });
        }, 3000);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [householdId, qc]);

  const fmt = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { timeStyle: 'medium', timeZone: timezone });
    const dayName = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone });
    return { time: (iso: string) => time.format(new Date(iso)), day: (iso: string) => dayName.format(new Date(iso)) };
  }, [locale, timezone]);

  const rows = useMemo(() => logRows(events.data?.pages.flat() ?? []), [events.data]);
  const byDay = useMemo(() => {
    const groups: { day: string; label: string; rows: LogRow[] }[] = [];
    for (const r of rows) {
      const at = r.type === 'span' ? r.start : r.at;
      const d = localDay(at, timezone);
      const g = groups.at(-1);
      if (g?.day === d) g.rows.push(r);
      else groups.push({ day: d, label: fmt.day(at), rows: [r] });
    }
    return groups;
  }, [rows, timezone, fmt]);

  const words = (kind: HomeKind) =>
    kind === 'presence'
      ? { on: t('house.log.detected'), off: t('house.log.cleared') }
      : kind === 'door' || kind === 'window'
        ? { on: t('house.log.opened'), off: t('house.log.closed') }
        : { on: t('house.state.on'), off: t('house.state.off') };

  function line(r: LogRow) {
    if (r.type === 'span') {
      const w = words(r.kind);
      return (
        <>
          <span className={r.kind === 'presence' ? 'text-info' : r.kind === 'binary' ? 'text-muted' : 'text-caution'}>
            {w.on} {fmt.time(r.start)}
          </span>
          {r.end ? (
            <>
              {' → '}
              <span className="text-teal">
                {w.off} {fmt.time(r.end)}
              </span>
              {r.seconds !== null && <span className="text-muted"> · {shortDuration(r.seconds)}</span>}
            </>
          ) : (
            <span className="text-muted"> · {t(r.kind === 'presence' ? 'house.log.stillHere' : 'house.log.stillOpen')}</span>
          )}
        </>
      );
    }
    if (r.type === 'value') {
      const v = sensorValue(r.value === null ? r.state : String(r.value), r.unit, i18n.language === 'si' ? 'si-LK' : 'en-LK');
      return (
        <>
          <span className="font-mono text-due">{v ?? t('house.state.unavailable')}</span>
          <span className="text-muted"> · {fmt.time(r.at)}</span>
        </>
      );
    }
    const w = words(r.kind);
    const state = r.state === 'on' ? w.on : r.state === 'off' ? w.off : r.state === 'unavailable' ? t('house.state.unavailable') : r.state;
    return (
      <>
        <span>{state}</span>
        <span className="text-muted"> · {fmt.time(r.at)}</span>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/house" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('house.title')}
      </Link>
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('house.log.title')}</h1>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('house.log.filter')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'h-9 rounded-full border px-3.5 text-[13.5px]',
                filter === f ? 'border-accent-b/60 bg-accent-b/15 text-text' : 'border-line-2 text-muted hover:text-text',
              )}
            >
              {t(`house.log.filters.${f}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={room ?? ''}
            onChange={(e) => setRoom(e.target.value || null)}
            aria-label={t('house.log.room')}
            className="glass h-10 min-w-0 rounded-xl px-3 text-[14px]"
          >
            <option value="">{t('house.log.allRooms')}</option>
            {rooms.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={day}
            max={localDay(new Date().toISOString(), timezone)}
            onChange={(e) => setDay(e.target.value)}
            aria-label={t('house.log.day')}
            className="glass h-10 rounded-xl px-3 text-[14px]"
          />
          {day && (
            <Button variant="ghost" size="sm" onClick={() => setDay('')}>
              {t('house.log.anyDay')}
            </Button>
          )}
        </div>
      </div>

      {events.isPending ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)] motion-reduce:animate-none" aria-hidden />
      ) : rows.length === 0 ? (
        <EmptyState icon={ScrollText} title={t('house.log.emptyTitle')} body={t('house.log.emptyBody')} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="house-log">
          {byDay.map((g) => (
            <Card key={g.day} className="flex min-w-0 flex-col gap-1">
              <h2 className="mb-1 font-display text-[16px] font-semibold">{g.label}</h2>
              <ul className="flex flex-col divide-y divide-line">
                {g.rows.map((r) => {
                  const Icon = ICON[r.kind];
                  return (
                    <li key={r.key} className="flex min-w-0 items-start gap-3 py-2.5" data-testid="log-row" data-kind={r.kind}>
                      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px]">
                          {r.name}
                          {r.area && <span className="text-muted"> · {r.area}</span>}
                        </div>
                        <div className="tabular text-[13.5px]">{line(r)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
          {events.hasNextPage && (
            <Button variant="secondary" className="self-center" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
              {t('house.log.more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
