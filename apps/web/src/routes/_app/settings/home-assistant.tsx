// Settings › Devices › Home Assistant (Phase 8): the bridge's health (online, Home Assistant
// reachable, what it found), the chooser — every door, window, light, switch and AC Home Assistant
// has, by room, with Show / Control and a short name (owner only) — and removing the bridge.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { AppWindow, ChevronLeft, DoorClosed, HousePlug, Lightbulb, Power, Snowflake, Trash2, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { HomeKind } from '@home/protocol';
import { useHomeLive } from '@/components/home/useHomeLive';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Toggle } from '@/components/ui/toggle';
import {
  bridgeOnline,
  bridgeQuery,
  entitiesQuery,
  homeErrorKey,
  invalidateHome,
  removeBridge,
  setEntity,
  type HomeEntity,
} from '@/lib/home/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/home-assistant')({
  component: HomeAssistantPage,
});

const ICON: Record<HomeKind, LucideIcon> = { door: DoorClosed, window: AppWindow, light: Lightbulb, switch: Power, climate: Snowflake };
const ORDER: Record<HomeKind, number> = { climate: 0, switch: 1, light: 2, door: 3, window: 4 };

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={cn('tabular truncate text-[15px]', tone)}>{value}</span>
    </div>
  );
}

function EntityRow({ e, isOwner }: { e: HomeEntity; isOwner: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [label, setLabel] = useState(e.label ?? '');
  const [busy, setBusy] = useState(false);
  const Icon = ICON[e.kind];
  const canControl = e.kind === 'light' || e.kind === 'switch' || e.kind === 'climate';

  async function change(p: { shown?: boolean; controllable?: boolean; label?: string | null }) {
    setBusy(true);
    try {
      const r = await setEntity(e.id, p);
      qc.setQueryData(entitiesQuery(e.household_id).queryKey, (old: HomeEntity[] | undefined) =>
        (old ?? []).map((x) => (x.id === e.id ? { ...x, ...r } : x)),
      );
    } catch (err) {
      toast.error(t(homeErrorKey(err)));
      await invalidateHome(qc, e.household_id, 'entities');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid="chooser-row" data-entity={e.entity_id}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Icon className={cn('h-5 w-5 shrink-0', e.shown ? 'text-accent-b' : 'text-faint')} aria-hidden />
        <div className="min-w-0 flex-1">
          {isOwner ? (
            <input
              value={label}
              placeholder={e.ha_name}
              maxLength={40}
              aria-label={t('house.chooser.shortName', { name: e.ha_name })}
              onChange={(ev) => setLabel(ev.target.value)}
              onBlur={() => {
                if ((label.trim() || null) !== (e.label ?? null)) void change({ label: label.trim() || null });
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
              }}
              className="w-full truncate rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[15px] outline-none placeholder:text-text hover:border-line-2 focus:border-accent-b"
            />
          ) : (
            <span className="block truncate px-1 text-[15px]">{e.label ?? e.ha_name}</span>
          )}
          <span className="block truncate px-1 font-mono text-[11.5px] text-faint">{e.entity_id}</span>
        </div>
      </div>
      <div className="flex items-center gap-5 pl-8 sm:pl-0">
        <label className="flex items-center gap-2 text-[13px] text-muted">
          {t('house.chooser.show')}
          <Toggle on={e.shown} disabled={!isOwner || busy} label={t('house.chooser.showLabel', { name: e.label ?? e.ha_name })} onChange={(v) => void change({ shown: v })} />
        </label>
        <label className={cn('flex items-center gap-2 text-[13px] text-muted', !canControl && 'invisible')}>
          {t('house.chooser.control')}
          <Toggle
            on={e.controllable}
            disabled={!isOwner || busy || !canControl}
            label={t('house.chooser.controlLabel', { name: e.label ?? e.ha_name })}
            onChange={(v) => void change({ controllable: v })}
          />
        </label>
      </div>
    </li>
  );
}

function HomeAssistantPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const isOwner = membership.role === 'owner';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bridge = useQuery({ ...bridgeQuery(householdId), refetchInterval: 30_000 });
  const entities = useQuery({ ...entitiesQuery(householdId), enabled: !!bridge.data });
  useHomeLive(householdId, !!bridge.data);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const when = new Intl.DateTimeFormat(membership.household.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.household.timezone });
  const collator = useMemo(() => new Intl.Collator(membership.household.locale), [membership.household.locale]);

  const rooms = useMemo(() => {
    const map = new Map<string | null, HomeEntity[]>();
    for (const e of entities.data ?? []) map.set(e.area, [...(map.get(e.area) ?? []), e]);
    return [...map.entries()]
      .map(([name, list]) => ({ name, list: list.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || collator.compare(a.ha_name, b.ha_name)) }))
      .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : collator.compare(a.name, b.name)));
  }, [entities.data, collator]);

  const back = (
    <Link to="/settings/devices" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {t('scale.devices.pageTitle')}
    </Link>
  );
  if (bridge.isPending) return <div className="glass h-40 animate-pulse rounded-[var(--r)] motion-reduce:animate-none" aria-hidden />;
  const b = bridge.data;
  if (!b) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Card className="text-muted">{t('house.devices.none')}</Card>
      </div>
    );
  }
  const online = bridgeOnline(b);
  const ha = b.status?.ha;
  const shown = (entities.data ?? []).filter((e) => e.shown).length;

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex items-center gap-3">
        <span className="brand-gradient flex h-12 w-12 items-center justify-center rounded-2xl text-[#05070F]">
          <HousePlug className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[28px] font-semibold tracking-tight">{b.name}</h1>
          <p className={cn('text-[14px]', online ? 'text-teal' : 'text-caution')}>
            {online
              ? t('house.bridge.online')
              : b.last_seen_at
                ? t('house.bridge.offlineSince', { when: when.format(new Date(b.last_seen_at)) })
                : t('house.bridge.never')}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={t('house.bridge.haLabel')} value={ha ? t(`house.bridge.haShort.${ha}`) : '–'} tone={ha && ha !== 'connected' ? 'text-caution' : undefined} />
        <Stat label={t('house.bridge.haVersion')} value={b.status?.ha_version ?? '–'} />
        <Stat label={t('house.bridge.found')} value={String(entities.data?.length ?? 0)} />
        <Stat label={t('house.bridge.shown')} value={String(shown)} />
      </div>

      <Card className="flex flex-col gap-2">
        <h2 className="font-display text-[18px] font-semibold">{t('house.chooser.title')}</h2>
        <p className="text-[13.5px] text-muted">{t(isOwner ? 'house.chooser.intro' : 'house.chooser.introMember')}</p>
        {rooms.length === 0 ? (
          <p className="text-[14px] text-muted">{t('house.chooser.nothing')}</p>
        ) : (
          rooms.map((r) => (
            <section key={r.name ?? '—'} className="mt-2">
              <h3 className="text-[13px] font-semibold tracking-wide text-[#a5b0d0] uppercase">{r.name ?? t('house.otherRoom')}</h3>
              <ul className="flex flex-col divide-y divide-line">
                {r.list.map((e) => (
                  <EntityRow key={`${e.id}:${e.label ?? ''}`} e={e} isOwner={isOwner} />
                ))}
              </ul>
            </section>
          ))
        )}
      </Card>

      <Card className="flex flex-col gap-2 text-[13.5px] text-muted">
        <h2 className="font-display text-[18px] font-semibold text-text">{t('house.security.title')}</h2>
        <p>{t('house.security.body')}</p>
      </Card>

      {isOwner && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-display text-[18px] font-semibold">{t('house.devices.remove')}</h2>
          <p className="text-[13.5px] text-muted">{t('house.devices.removeBody')}</p>
          {confirmRemove ? (
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={async () => {
                  try {
                    await removeBridge(b.id);
                    await invalidateHome(qc, householdId);
                    void navigate({ to: '/settings/devices' });
                  } catch (e) {
                    toast.error(t(homeErrorKey(e)));
                  }
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('house.devices.removeConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="destructive" className="self-start" onClick={() => setConfirmRemove(true)}>
              {t('house.devices.remove')}
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
