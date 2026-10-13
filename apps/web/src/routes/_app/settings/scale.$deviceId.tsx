// One kitchen scale (Phase 6b): health (MASTER_PLAN §7b Diagnostics: last seen, firmware, Wi-Fi,
// queue), test buttons, sound + weighing settings, the calibration wizard, firmware updates, its last
// readings, and removing it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { BellRing, ChevronLeft, Crosshair, Gauge, Scale } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/pantry/bits';
import { CalibrateSheet } from '@/components/scale/CalibrateSheet';
import { FirmwarePanel } from '@/components/scale/FirmwarePanel';
import { ReadingCard } from '@/components/scale/ReadingCard';
import { ScaleLog } from '@/components/scale/ScaleLog';
import { useScaleLive } from '@/components/scale/useScaleLive';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { deviceOnline, formatLatency, wifiQuality } from '@/lib/scale/format';
import {
  readingsQuery,
  revokeScale,
  scaleErrorKey,
  scalesQuery,
  sendCommand,
  updateScale,
  type ScaleCommand,
  type ScaleSettings,
} from '@/lib/scale/queries';

export const Route = createFileRoute('/_app/settings/scale/$deviceId')({
  component: ScalePage,
});

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`tabular truncate text-[15px] ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function SettingsForm({ deviceId, settings, canWrite }: { deviceId: string; settings: ScaleSettings; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateScale(deviceId, { settings: s });
      toast.success(t('scale.settings.saved'));
      await qc.invalidateQueries({ queryKey: ['scale'] });
    } catch (err) {
      toast.error(t(`scale.errors.${scaleErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
        <h2 className="font-display text-[19px] font-semibold">{t('scale.settings.title')}</h2>
        <div>
          <label className={fieldLabel} htmlFor="volume">
            {t('scale.settings.volume', { volume: s.volume })}
          </label>
          <input
            id="volume"
            type="range"
            min={0}
            max={100}
            step={5}
            value={s.volume}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, volume: Number(e.target.value) })}
            className="w-full accent-[var(--accent-a)]"
          />
        </div>
        <label className="flex items-center gap-3 text-[14px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent-a)]"
            checked={s.voice}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, voice: e.target.checked })}
          />
          {t('scale.settings.voice')}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={fieldLabel} htmlFor="quiet-from">
              {t('scale.settings.quietFrom')}
            </label>
            <Input id="quiet-from" type="time" value={s.quiet_from} disabled={!canWrite} onChange={(e) => setS({ ...s, quiet_from: e.target.value })} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="quiet-to">
              {t('scale.settings.quietTo')}
            </label>
            <Input id="quiet-to" type="time" value={s.quiet_to} disabled={!canWrite} onChange={(e) => setS({ ...s, quiet_to: e.target.value })} />
          </div>
        </div>
        <p className="-mt-2 text-[12.5px] text-faint">{t('scale.settings.quietHint')}</p>
        <div>
          <label className={fieldLabel} htmlFor="threshold">
            {t('scale.settings.threshold')}
          </label>
          <Input
            id="threshold"
            type="number"
            min={1}
            max={20}
            step={1}
            value={s.threshold_g}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, threshold_g: Number(e.target.value) })}
            className="max-w-[120px]"
          />
          <p className="mt-1.5 text-[12.5px] text-faint">{t('scale.settings.thresholdHint')}</p>
        </div>
        {canWrite && (
          <Button type="submit" disabled={busy}>
            {t('scale.settings.save')}
          </Button>
        )}
      </form>
    </Card>
  );
}

function ScalePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { deviceId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const isOwner = membership.role === 'owner';
  const canWrite = membership.role !== 'viewer';
  const scales = useQuery({ ...scalesQuery(householdId), refetchInterval: 15_000 });
  const readings = useQuery(readingsQuery(householdId, { deviceId, limit: 20 }));
  const [calibrating, setCalibrating] = useState(false);
  useScaleLive(householdId);

  const device = scales.data?.find((d) => d.id === deviceId);
  if (scales.isPending) return <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!device || device.revoked_at) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="font-display text-xl font-semibold">{t('scale.detail.notFound')}</h1>
        <Link to="/settings/devices" className="text-sm text-accent-b underline">
          {t('scale.devices.pageTitle')}
        </Link>
      </Card>
    );
  }

  const dt = new Intl.DateTimeFormat(membership.household.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: membership.household.timezone,
  });
  const online = deviceOnline(device.last_seen_at);
  const st = device.status ?? {};
  const wifi = wifiQuality(st.rssi);

  async function command(c: ScaleCommand) {
    try {
      await sendCommand(device!.id, c);
      toast.success(t('scale.detail.sent'));
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    }
  }

  async function remove() {
    if (!window.confirm(t('scale.detail.removeConfirm', { name: device!.name }))) return;
    try {
      await revokeScale(device!.id);
      toast.success(t('scale.detail.removed', { name: device!.name }));
      void navigate({ to: '/settings/devices' });
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings/devices" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('scale.devices.pageTitle')}
      </Link>
      <div className="flex items-center gap-3">
        <Scale className="h-7 w-7 text-accent-b" aria-hidden />
        <h1 className="flex-1 font-display text-[28px] font-semibold tracking-tight">{device.name}</h1>
        <span className={online ? 'text-teal' : 'text-caution'}>{t(online ? 'scale.devices.online' : 'scale.devices.offline')}</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" data-testid="scale-health">
        <Stat label={t('scale.detail.lastSeen')} value={device.last_seen_at ? dt.format(new Date(device.last_seen_at)) : t('scale.devices.notYet')} />
        <Stat label={t('scale.detail.firmware')} value={device.fw_version ?? '—'} />
        <Stat
          label={t('scale.detail.wifi')}
          value={st.rssi != null ? `${st.rssi} dBm · ${t(`scale.detail.wifiQuality.${wifi}`)}` : '—'}
          tone={wifi === 'weak' ? 'text-caution' : undefined}
        />
        <Stat label={t('scale.detail.queue')} value={String(st.queue ?? 0)} tone={(st.queue ?? 0) > 0 ? 'text-caution' : undefined} />
        <Stat label={t('scale.detail.calibrated')} value={device.calibrated_at ? dt.format(new Date(device.calibrated_at)) : t('scale.detail.never')} />
        <Stat label={t('scale.detail.latency')} value={st.latency_ms != null ? formatLatency(st.latency_ms) : '—'} />
        <Stat label={t('scale.detail.readings')} value={String(device.reading_count)} />
        <Stat label={t('scale.detail.restart')} value={st.reset ?? '—'} />
      </div>
      {st.err && <p className="text-[13.5px] text-red">{t('scale.detail.lastError', { error: st.err })}</p>}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void command('beep')}>
            <BellRing className="h-4 w-4" aria-hidden />
            {t('scale.detail.beep')}
          </Button>
          <Button onClick={() => void command('identify')}>
            <Crosshair className="h-4 w-4" aria-hidden />
            {t('scale.detail.identify')}
          </Button>
          <Button onClick={() => void command('tare')}>{t('scale.detail.zero')}</Button>
          <Button variant="accent" onClick={() => setCalibrating(true)}>
            <Gauge className="h-4 w-4" aria-hidden />
            {t('scale.detail.calibrate')}
          </Button>
        </div>
      )}

      {/* Keyed by version: a change saved elsewhere resets the form to the new values. */}
      <SettingsForm key={device.settings_version} deviceId={device.id} settings={device.settings} canWrite={canWrite} />
      <FirmwarePanel householdId={householdId} device={device} isOwner={isOwner} locale={membership.household.locale} />
      <ScaleLog householdId={householdId} deviceId={device.id} timezone={membership.household.timezone} />

      {(readings.data?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="font-display text-[19px] font-semibold">{t('scale.page.recent')}</h2>
          {readings.data!.map((r) => (
            <ReadingCard key={r.id} reading={r} householdId={householdId} canWrite={canWrite} />
          ))}
        </section>
      )}

      {isOwner && (
        <Button variant="destructive" className="self-start" onClick={() => void remove()}>
          {t('scale.detail.remove')}
        </Button>
      )}

      {calibrating && <CalibrateSheet open={calibrating} onClose={() => setCalibrating(false)} householdId={householdId} deviceId={device.id} />}
    </div>
  );
}
