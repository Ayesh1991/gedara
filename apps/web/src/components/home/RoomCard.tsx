// One room of the House page (Phase 8): its AC, switches (vaporizer, emergency light …), lights,
// then its doors and windows. Status colours never change with the theme: open = amber (caution),
// closed = teal, a light that's on = violet (info), unavailable = faint.
import { AppWindow, DoorClosed, DoorOpen, Lightbulb, LightbulbOff, Minus, Plus, Power, Snowflake } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HomeAction } from '@home/protocol';
import { Card } from '@/components/ui/card';
import { Toggle } from '@/components/ui/toggle';
import { displayName, isAvailable, isOn, isOpen, nextTemperature, type HomeEntity, type Room } from '@/lib/home/queries';
import { cn } from '@/lib/utils';

type Act = (e: HomeEntity, action: HomeAction, args?: Record<string, unknown>) => Promise<void>;

interface Props {
  room: Room;
  canWrite: boolean;
  act: Act;
  busy: ReadonlySet<string>;
  time: (iso: string) => string;
}

function Status({ e }: { e: HomeEntity }) {
  const { t } = useTranslation();
  if (!isAvailable(e)) return <span className="text-[13px] text-faint">{t('house.state.unavailable')}</span>;
  return null;
}

function AcTile({ e, canWrite, act, busy }: { e: HomeEntity; canWrite: boolean; act: Act; busy: boolean }) {
  const { t } = useTranslation();
  const available = isAvailable(e);
  const on = isOn(e);
  const can = canWrite && e.controllable && available;
  const modes = (e.attrs.hvac_modes ?? []).filter((m) => m !== 'off');
  // Taps on − / + gather for a moment, then one command goes (the last temperature wins).
  const [target, setTarget] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const shown = target ?? e.attrs.temperature ?? null;
  const step = (dir: 1 | -1) => {
    const next = nextTemperature({ ...e, attrs: { ...e.attrs, temperature: shown ?? e.attrs.temperature } }, dir);
    if (next === null) return;
    setTarget(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void act(e, 'set_temperature', { temperature: next }).finally(() => setTarget(null));
    }, 700);
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 p-4" data-testid="ac-tile">
      <div className="flex items-center gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', on ? 'bg-due/15 text-due' : 'bg-white/5 text-muted')}>
          <Snowflake className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15.5px] font-medium">{displayName(e)}</span>
          <span className="tabular block text-[13px] text-muted">
            {available ? (on ? t(`house.mode.${e.state}`, { defaultValue: e.state ?? '' }) : t('house.state.off')) : t('house.state.unavailable')}
            {e.attrs.current_temperature != null && ` · ${t('house.ac.room', { t: e.attrs.current_temperature })}`}
          </span>
        </span>
        {e.controllable && (
          <Toggle on={on} disabled={!can || busy} label={t('house.ac.power', { name: displayName(e) })} onChange={(v) => void act(e, v ? 'turn_on' : 'turn_off')} />
        )}
      </div>
      {e.controllable && (
        <>
          <div className="flex items-center justify-center gap-5">
            <button
              type="button"
              disabled={!can || shown === null || nextTemperature({ ...e, attrs: { ...e.attrs, temperature: shown ?? undefined } }, -1) === null}
              onClick={() => step(-1)}
              aria-label={t('house.ac.colder')}
              className="glass flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-40"
            >
              <Minus className="h-5 w-5" aria-hidden />
            </button>
            <span className="tabular min-w-[4.5ch] text-center font-mono text-[34px] leading-none" aria-live="polite" data-testid="ac-target">
              {shown == null ? '—' : `${shown}°`}
            </span>
            <button
              type="button"
              disabled={!can || shown === null || nextTemperature({ ...e, attrs: { ...e.attrs, temperature: shown ?? undefined } }, 1) === null}
              onClick={() => step(1)}
              aria-label={t('house.ac.warmer')}
              className="glass flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-40"
            >
              <Plus className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {modes.length > 1 && (
            <div className="flex flex-wrap justify-center gap-2" role="group" aria-label={t('house.ac.modes')}>
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={!can || busy}
                  aria-pressed={e.state === m}
                  onClick={() => void act(e, 'set_hvac_mode', { hvac_mode: m })}
                  className={cn(
                    'h-9 rounded-full border px-3.5 text-[13.5px] disabled:opacity-40',
                    e.state === m ? 'border-due/60 bg-due/15 text-text' : 'border-line-2 text-muted hover:text-text',
                  )}
                >
                  {t(`house.mode.${m}`, { defaultValue: m })}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SwitchRow({ e, canWrite, act, busy }: { e: HomeEntity; canWrite: boolean; act: Act; busy: boolean }) {
  const { t } = useTranslation();
  const on = isOn(e);
  const light = e.kind === 'light';
  const Icon = light ? (on ? Lightbulb : LightbulbOff) : Power;
  return (
    <li className="flex min-h-12 items-center gap-3" data-testid="switch-row">
      <Icon className={cn('h-5 w-5 shrink-0', !isAvailable(e) ? 'text-faint' : on ? (light ? 'text-info' : 'text-teal') : 'text-muted')} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[15px]">{displayName(e)}</span>
      {e.controllable ? (
        <Toggle
          on={on}
          disabled={!canWrite || !isAvailable(e) || busy}
          label={t('house.switchLabel', { name: displayName(e) })}
          onChange={(v) => void act(e, v ? 'turn_on' : 'turn_off')}
        />
      ) : isAvailable(e) ? (
        <span className={cn('text-[13.5px]', on ? (light ? 'text-info' : 'text-teal') : 'text-muted')}>{on ? t('house.state.on') : t('house.state.off')}</span>
      ) : (
        <Status e={e} />
      )}
    </li>
  );
}

function OpeningRow({ e, time }: { e: HomeEntity; time: (iso: string) => string }) {
  const { t } = useTranslation();
  const open = isOpen(e);
  const Icon = e.kind === 'window' ? AppWindow : open ? DoorOpen : DoorClosed;
  return (
    <li className="flex min-h-11 items-center gap-3" data-testid="opening-row" data-open={open || undefined}>
      <Icon className={cn('h-5 w-5 shrink-0', !isAvailable(e) ? 'text-faint' : open ? 'text-caution' : 'text-teal')} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[15px]">{displayName(e)}</span>
      {!isAvailable(e) ? (
        <Status e={e} />
      ) : (
        <span className={cn('tabular text-[13.5px]', open ? 'text-caution' : 'text-teal')}>
          {open ? (e.changed_at ? t('house.state.openSince', { time: time(e.changed_at) }) : t('house.state.open')) : t('house.state.closed')}
        </span>
      )}
    </li>
  );
}

export function RoomCard({ room, canWrite, act, busy, time }: Props) {
  const { t } = useTranslation();
  const open = room.openings.filter(isOpen).length;
  return (
    <Card className="flex min-w-0 flex-col gap-4" data-testid="room-card" aria-label={room.name ?? t('house.otherRoom')}>
      <div className="flex items-baseline gap-3">
        <h2 className="min-w-0 flex-1 truncate font-display text-[19px] font-semibold">{room.name ?? t('house.otherRoom')}</h2>
        {room.openings.length > 0 && (
          <span className={cn('text-[13px]', open ? 'text-caution' : 'text-teal')}>
            {open ? t('house.room.open', { count: open }) : t('house.room.closed')}
          </span>
        )}
      </div>
      {room.climates.map((e) => (
        <AcTile key={e.id} e={e} canWrite={canWrite} act={act} busy={busy.has(e.id)} />
      ))}
      {(room.switches.length > 0 || room.lights.length > 0) && (
        <ul className="flex flex-col divide-y divide-line">
          {[...room.switches, ...room.lights].map((e) => (
            <SwitchRow key={e.id} e={e} canWrite={canWrite} act={act} busy={busy.has(e.id)} />
          ))}
        </ul>
      )}
      {room.openings.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {room.openings.map((e) => (
            <OpeningRow key={e.id} e={e} time={time} />
          ))}
        </ul>
      )}
    </Card>
  );
}
