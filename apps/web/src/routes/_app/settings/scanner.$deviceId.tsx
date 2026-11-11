// One bin scanner (Phase 11): health (last seen, firmware, Wi-Fi, waiting scans), pause / resume,
// test buttons, sound + scanner-eye + key settings, "undo everything since", firmware updates, its
// log, its last scans, and removing it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { BellRing, ChevronLeft, Crosshair, Pause, Play, ScanBarcode, TriangleAlert, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel, selectClass } from '@/components/pantry/bits';
import { FirmwarePanel } from '@/components/scale/FirmwarePanel';
import { ScaleLog } from '@/components/scale/ScaleLog';
import { ScanCard } from '@/components/scanner/ScanCard';
import { useScannerLive } from '@/components/scanner/useScannerLive';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatLatency, wifiQuality } from '@/lib/scale/format';
import { keymapVariants, scannerOnline } from '@/lib/scanner/format';
import {
  invalidateScanner,
  pauseScanner,
  resumeScanner,
  revokeScanner,
  scannerErrorKey,
  scannersQuery,
  scansQuery,
  sendScannerCommand,
  undoScannerSince,
  updateScanner,
  waitingScansQuery,
  type ScannerCommand,
  type ScannerDevice,
} from '@/lib/scanner/queries';
import type { ScannerSettings } from '@scanner/protocol';

export const Route = createFileRoute('/_app/settings/scanner/$deviceId')({
  component: ScannerPage,
});

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`tabular truncate text-[15px] ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function SettingsForm({ deviceId, settings, canWrite }: { deviceId: string; settings: ScannerSettings; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const variants = keymapVariants();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateScanner(deviceId, { settings: s });
      toast.success(t('scanner.settings.saved'));
      await qc.invalidateQueries({ queryKey: ['scanner'] });
    } catch (err) {
      toast.error(t(`scanner.errors.${scannerErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)} data-testid="scanner-settings">
        <h2 className="font-display text-[19px] font-semibold">{t('scanner.settings.title')}</h2>
        <div>
          <label className={fieldLabel} htmlFor="sc-volume">
            {t('scanner.settings.volume', { volume: s.volume })}
          </label>
          <input
            id="sc-volume"
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={fieldLabel} htmlFor="sc-quiet-from">
              {t('scanner.settings.quietFrom')}
            </label>
            <Input id="sc-quiet-from" type="time" value={s.quiet_from} disabled={!canWrite} onChange={(e) => setS({ ...s, quiet_from: e.target.value })} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="sc-quiet-to">
              {t('scanner.settings.quietTo')}
            </label>
            <Input id="sc-quiet-to" type="time" value={s.quiet_to} disabled={!canWrite} onChange={(e) => setS({ ...s, quiet_to: e.target.value })} />
          </div>
        </div>
        <p className="-mt-2 text-[12.5px] text-faint">{t('scanner.settings.quietHint')}</p>
        <label className="flex items-center gap-3 text-[14px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent-a)]"
            checked={s.night_off}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, night_off: e.target.checked })}
          />
          {t('scanner.settings.nightOff')}
        </label>
        <div>
          <label className={fieldLabel} htmlFor="sc-bright">
            {t('scanner.settings.bright', { bright: s.bright })}
          </label>
          <input
            id="sc-bright"
            type="range"
            min={10}
            max={100}
            step={10}
            value={s.bright}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, bright: Number(e.target.value) })}
            className="w-full accent-[var(--accent-a)]"
          />
        </div>

        <div>
          <label className={fieldLabel} htmlFor="sc-eye">
            {t('scanner.settings.eye')}
          </label>
          <select id="sc-eye" className={selectClass} value={s.eye} disabled={!canWrite} onChange={(e) => setS({ ...s, eye: e.target.value as ScannerSettings['eye'] })}>
            {(['sense', 'always', 'key'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`scanner.settings.eyes.${v}`)}
              </option>
            ))}
          </select>
          <label className="mt-2.5 flex items-center gap-3 text-[14px]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent-a)]"
              checked={s.eye_quiet === 'key'}
              disabled={!canWrite || s.eye === 'key'}
              onChange={(e) => setS({ ...s, eye_quiet: e.target.checked ? 'key' : 'same' })}
            />
            {t('scanner.settings.eyeQuiet')}
          </label>
        </div>

        <div>
          <label className={fieldLabel} htmlFor="sc-mode">
            {t('scanner.settings.modeTime')}
          </label>
          <Input
            id="sc-mode"
            type="number"
            min={10}
            max={120}
            step={5}
            value={s.mode_s}
            disabled={!canWrite}
            onChange={(e) => setS({ ...s, mode_s: Number(e.target.value) })}
            className="max-w-[120px]"
          />
          <p className="mt-1.5 text-[12.5px] text-faint">{t('scanner.settings.modeTimeHint')}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className={fieldLabel} htmlFor="sc-buzzer">
              {t('scanner.settings.buzzer')}
            </label>
            <select
              id="sc-buzzer"
              className={selectClass}
              value={s.buzzer}
              disabled={!canWrite}
              onChange={(e) => setS({ ...s, buzzer: e.target.value as ScannerSettings['buzzer'] })}
            >
              <option value="passive">{t('scanner.settings.buzzers.passive')}</option>
              <option value="active">{t('scanner.settings.buzzers.active')}</option>
            </select>
          </div>
          <div>
            <label className={fieldLabel} htmlFor="sc-keymap">
              {t('scanner.settings.keymap')}
            </label>
            <select id="sc-keymap" className={selectClass} value={s.keymap} disabled={!canWrite} onChange={(e) => setS({ ...s, keymap: e.target.value })}>
              {variants.map((v) => (
                <option key={v.id} value={v.map}>
                  {t(`scanner.settings.keymaps.${v.id}`)}
                </option>
              ))}
              {!variants.some((v) => v.map === s.keymap) && <option value={s.keymap}>{s.keymap}</option>}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-[12.5px] text-faint">{t('scanner.settings.keymapHint')}</p>

        {canWrite && (
          <Button type="submit" disabled={busy}>
            {t('scanner.settings.save')}
          </Button>
        )}
      </form>
    </Card>
  );
}

function PauseCard({ device, isOwner, canWrite, held, householdId }: { device: ScannerDevice; isOwner: boolean; canWrite: boolean; held: number; householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState('1');

  async function run(fn: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast.success(msg);
      await invalidateScanner(qc, householdId);
    } catch (e) {
      toast.error(t(`scanner.errors.${scannerErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`flex flex-col gap-3 ${device.paused_at ? 'border-caution/50' : ''}`} data-testid="scanner-pause">
      {device.paused_at ? (
        <>
          <h2 className="flex items-center gap-2 font-display text-[19px] font-semibold text-caution">
            <TriangleAlert className="h-5 w-5" aria-hidden />
            {t('scanner.pause.pausedTitle')}
          </h2>
          <p className="text-[14px] text-muted">{t(`scanner.pause.reasons.${device.paused_reason ?? 'manual'}`)}</p>
          {held > 0 && <p className="tabular text-[14px]">{t('scanner.pause.held', { count: held })}</p>}
          {isOwner ? (
            <div className="flex flex-wrap gap-2">
              {held > 0 ? (
                <>
                  <Button variant="accent" disabled={busy} onClick={() => void run(async () => (await resumeScanner(device.id, 'apply'), t('scanner.pause.resumed')))}>
                    <Play className="h-4 w-4" aria-hidden />
                    {t('scanner.pause.resumeApply')}
                  </Button>
                  <Button disabled={busy} onClick={() => void run(async () => (await resumeScanner(device.id, 'drop'), t('scanner.pause.resumed')))}>
                    {t('scanner.pause.resumeDrop')}
                  </Button>
                </>
              ) : (
                <Button variant="accent" disabled={busy} onClick={() => void run(async () => (await resumeScanner(device.id, 'keep'), t('scanner.pause.resumed')))}>
                  <Play className="h-4 w-4" aria-hidden />
                  {t('scanner.pause.resume')}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-faint">{t('scanner.pause.ownerOnly')}</p>
          )}
        </>
      ) : (
        <>
          <h2 className="font-display text-[19px] font-semibold">{t('scanner.pause.title')}</h2>
          <p className="text-[14px] text-muted">{t('scanner.pause.intro')}</p>
          {canWrite && (
            <Button className="self-start" disabled={busy} onClick={() => void run(async () => (await pauseScanner(device.id), t('scanner.pause.pausedToast')))}>
              <Pause className="h-4 w-4" aria-hidden />
              {t('scanner.pause.pause')}
            </Button>
          )}
        </>
      )}

      {isOwner && (
        <div className="mt-1 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div>
            <label className={fieldLabel} htmlFor="sc-undo-hours">
              {t('scanner.pause.undoSince')}
            </label>
            <select id="sc-undo-hours" className={selectClass} value={hours} onChange={(e) => setHours(e.target.value)}>
              {['1', '6', '24', '72'].map((h) => (
                <option key={h} value={h}>
                  {t('scanner.pause.hours', { count: Number(h) })}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t('scanner.pause.undoConfirm', { name: device.name, count: Number(hours) }))) return;
              void run(async () => {
                const r = await undoScannerSince(device.id, new Date(Date.now() - Number(hours) * 3_600_000));
                return t('scanner.pause.undoDone', { undone: r.undone, failed: r.failed });
              });
            }}
          >
            <Undo2 className="h-4 w-4" aria-hidden />
            {t('scanner.pause.undoButton')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ScannerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { deviceId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const isOwner = membership.role === 'owner';
  const canWrite = membership.role !== 'viewer';
  const scanners = useQuery(scannersQuery(householdId));
  const scans = useQuery(scansQuery(householdId, { deviceId, limit: 20 }));
  const waiting = useQuery(waitingScansQuery(householdId));
  useScannerLive(householdId);

  const device = scanners.data?.find((d) => d.id === deviceId);
  if (scanners.isPending) return <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!device || device.revoked_at) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="font-display text-xl font-semibold">{t('scanner.detail.notFound')}</h1>
        <Link to="/settings/devices" className="text-sm text-accent-b underline">
          {t('scale.devices.pageTitle')}
        </Link>
      </Card>
    );
  }

  const dt = new Intl.DateTimeFormat(membership.household.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.household.timezone });
  const time = new Intl.DateTimeFormat(membership.household.locale, { dateStyle: 'short', timeStyle: 'short', timeZone: membership.household.timezone });
  const online = scannerOnline(device.last_seen_at);
  const st = device.status ?? {};
  const wifi = wifiQuality(st.rssi);
  const held = (waiting.data ?? []).filter((s) => s.status === 'held' && s.device_id === deviceId).length;

  async function command(c: ScannerCommand) {
    try {
      await sendScannerCommand(device!.id, c);
      toast.success(t('scanner.detail.sent'));
    } catch (e) {
      toast.error(t(`scanner.errors.${scannerErrorKey(e)}`));
    }
  }

  async function remove() {
    if (!window.confirm(t('scanner.detail.removeConfirm', { name: device!.name }))) return;
    try {
      await revokeScanner(device!.id);
      toast.success(t('scanner.detail.removed', { name: device!.name }));
      void navigate({ to: '/settings/devices' });
    } catch (e) {
      toast.error(t(`scanner.errors.${scannerErrorKey(e)}`));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings/devices" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('scale.devices.pageTitle')}
      </Link>
      <div className="flex items-center gap-3">
        <ScanBarcode className="h-7 w-7 text-accent-b" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate font-display text-[28px] font-semibold tracking-tight">{device.name}</h1>
        <span className={device.paused_at ? 'text-caution' : online ? 'text-teal' : 'text-caution'}>
          {t(device.paused_at ? 'scanner.devices.paused' : online ? 'scanner.devices.online' : 'scanner.devices.offline')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" data-testid="scanner-health">
        <Stat label={t('scanner.detail.lastSeen')} value={device.last_seen_at ? dt.format(new Date(device.last_seen_at)) : t('scanner.devices.notYet')} />
        <Stat label={t('scanner.detail.firmware')} value={device.fw_version ?? '—'} />
        <Stat
          label={t('scanner.detail.wifi')}
          value={st.rssi != null ? `${st.rssi} dBm · ${t(`scale.detail.wifiQuality.${wifi}`)}` : '—'}
          tone={wifi === 'weak' ? 'text-caution' : undefined}
        />
        <Stat label={t('scanner.detail.queue')} value={String(st.queue ?? 0)} tone={(st.queue ?? 0) > 0 ? 'text-caution' : undefined} />
        <Stat label={t('scanner.detail.eye')} value={st.eye ? t(`scanner.detail.eyes.${(['sense', 'always', 'key', 'missing'] as const).find((e) => e === st.eye) ?? 'other'}`) : '—'} tone={st.eye === 'missing' ? 'text-red' : undefined} />
        <Stat label={t('scanner.detail.latency')} value={st.latency_ms != null ? formatLatency(st.latency_ms) : '—'} />
        <Stat label={t('scanner.detail.scans')} value={String(device.reading_count)} />
        <Stat label={t('scanner.detail.restart')} value={st.reset ?? '—'} />
      </div>
      {st.err && <p className="text-[13.5px] text-red">{t('scanner.detail.lastError', { error: st.err })}</p>}
      <p className="-mt-2 text-[12.5px] text-faint">{t('scanner.detail.contactHint')}</p>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void command('beep')}>
            <BellRing className="h-4 w-4" aria-hidden />
            {t('scanner.detail.beep')}
          </Button>
          <Button onClick={() => void command('identify')}>
            <Crosshair className="h-4 w-4" aria-hidden />
            {t('scanner.detail.identify')}
          </Button>
          {isOwner && <Button onClick={() => void command('reboot')}>{t('scanner.detail.reboot')}</Button>}
          <Link to="/pantry/scanner" className="inline-flex h-12 items-center rounded-2xl px-4 text-[15px] text-accent-b hover:bg-white/5">
            {t('scanner.detail.openPage')}
          </Link>
        </div>
      )}

      <PauseCard device={device} isOwner={isOwner} canWrite={canWrite} held={held} householdId={householdId} />
      {/* Keyed by version: a change saved elsewhere resets the form to the new values. */}
      <SettingsForm key={device.settings_version} deviceId={device.id} settings={device.settings} canWrite={canWrite} />
      <FirmwarePanel
        householdId={householdId}
        device={device}
        isOwner={isOwner}
        locale={membership.household.locale}
        kind="scanner"
        hint={t('scanner.detail.firmwareHint')}
      />
      <ScaleLog householdId={householdId} deviceId={device.id} timezone={membership.household.timezone} />

      {(scans.data?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="font-display text-[19px] font-semibold">{t('scanner.page.recent')}</h2>
          {scans.data!.map((s) => (
            <ScanCard key={s.id} scan={s} householdId={householdId} canWrite={canWrite} when={time.format(new Date(s.at))} />
          ))}
        </section>
      )}

      {isOwner && (
        <Button variant="destructive" className="self-start" onClick={() => void remove()}>
          {t('scanner.detail.remove')}
        </Button>
      )}
    </div>
  );
}
