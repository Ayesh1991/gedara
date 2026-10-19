// One music speaker (Phase 7h): its health (online, sound output, space on the SD card, songs,
// temperature), a test sound, the volume limit and sleep fade, wind-down schedules, and removing it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { BellRing, ChevronLeft, FolderSync, Moon, Plus, Speaker as SpeakerIcon, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NetworkSpeakerCard } from '@/components/media/NetworkSpeakerCard';
import { useMediaLive } from '@/components/media/useMediaLive';
import {
  DAY_BITS,
  deleteSchedule,
  invalidateMedia,
  mediaErrorKey,
  playlistsQuery,
  removeSpeaker,
  saveSchedule,
  schedulesQuery,
  sendMediaCommand,
  speakerOnline,
  speakersQuery,
  tracksQuery,
  updateSpeaker,
  waitForMediaCommand,
  type MediaSchedule,
  type Speaker,
  type SpeakerSettings,
} from '@/lib/media/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/speaker/$deviceId')({
  component: SpeakerPage,
});

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={cn('tabular truncate text-[15px]', tone)}>{value}</span>
    </div>
  );
}

function SettingsForm({ speaker, canWrite }: { speaker: Speaker; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(speaker.name);
  // Defaults for keys an older speaker row may not have.
  const [s, setS] = useState<SpeakerSettings>({ ...{ volume_max: 80, fade_s: 8, normalise: true }, ...speaker.settings });
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateSpeaker(speaker.id, { name: name.trim(), settings: s });
      toast.success(t('music.speaker.saved'));
      await invalidateMedia(qc, speaker.household_id, 'speakers');
    } catch (err) {
      toast.error(t(mediaErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form onSubmit={save} className="flex flex-col gap-4">
        <h2 className="font-display text-[18px] font-semibold">{t('music.speaker.settings')}</h2>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.devices.name')}</span>
          <Input value={name} maxLength={40} disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.speaker.volumeMax', { v: s.volume_max })}</span>
          <input type="range" min={10} max={100} step={5} value={s.volume_max} disabled={!canWrite}
            onChange={(e) => setS({ ...s, volume_max: Number(e.target.value) })} className="accent-[var(--accent-b)]" />
          <span className="text-[12.5px] text-muted">{t('music.speaker.volumeMaxHint')}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.speaker.fade', { s: s.fade_s })}</span>
          <input type="range" min={0} max={60} step={1} value={s.fade_s} disabled={!canWrite}
            onChange={(e) => setS({ ...s, fade_s: Number(e.target.value) })} className="accent-[var(--accent-b)]" />
        </label>
        <label className="flex items-center gap-3 text-[14.5px]">
          <input type="checkbox" className="h-5 w-5 accent-[var(--accent-a)]" checked={s.normalise} disabled={!canWrite}
            onChange={(e) => setS({ ...s, normalise: e.target.checked })} />
          <span>
            {t('music.speaker.normalise')}
            <span className="block text-[12.5px] text-muted">{t('music.speaker.normaliseHint')}</span>
          </span>
        </label>
        {canWrite && (
          <Button type="submit" variant="accent" disabled={busy || !name.trim()} className="self-start">
            {t('common.save')}
          </Button>
        )}
      </form>
    </Card>
  );
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function ScheduleForm({ speaker, initial, onDone }: { speaker: Speaker; initial?: MediaSchedule; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const playlists = useQuery(playlistsQuery(speaker.household_id));
  const [f, setF] = useState({
    name: initial?.name ?? t('music.schedule.defaultName'),
    days: initial?.days ?? 127,
    start_time: (initial?.start_time ?? '21:30').slice(0, 5),
    playlist_id: initial?.playlist_id ?? '',
    volume: initial?.volume ?? 35,
    stop_after_min: initial?.stop_after_min ?? 45,
    fade_s: initial?.fade_s ?? 30,
    shuffle: initial?.shuffle ?? false,
    enabled: initial?.enabled ?? true,
  });
  const [busy, setBusy] = useState(false);
  const days = t('music.schedule.days').split(',');
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!TIME_RE.test(f.start_time) || f.days === 0) return;
    setBusy(true);
    try {
      await saveSchedule({
        id: initial?.id,
        household_id: speaker.household_id,
        device_id: speaker.id,
        name: f.name.trim(),
        days: f.days,
        start_time: f.start_time,
        playlist_id: f.playlist_id || null,
        volume: Math.min(f.volume, speaker.settings?.volume_max ?? 100),
        stop_after_min: f.stop_after_min || null,
        fade_s: f.fade_s,
        shuffle: f.shuffle,
        enabled: f.enabled,
      });
      await invalidateMedia(qc, speaker.household_id, 'schedules');
      toast.success(t('music.schedule.saved'));
      onDone();
    } catch (err) {
      toast.error(t(mediaErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4 rounded-2xl border border-line bg-white/[0.02] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.schedule.name')}</span>
          <Input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.schedule.start')}</span>
          <Input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} className="tabular" />
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t('music.schedule.onDays')}</span>
        <div className="flex gap-1.5" role="group" aria-label={t('music.schedule.onDays')}>
          {DAY_BITS.map((bit, i) => {
            const on = (f.days & bit) !== 0;
            return (
              <button key={bit} type="button" aria-pressed={on} onClick={() => setF({ ...f, days: f.days ^ bit })}
                className={cn('h-10 w-10 rounded-full text-[13px] font-semibold', on ? 'accent-pill text-text' : 'border border-line-2 text-muted')}>
                {days[i]}
              </button>
            );
          })}
        </div>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t('music.schedule.playlist')}</span>
        <select value={f.playlist_id} onChange={(e) => setF({ ...f, playlist_id: e.target.value })}
          className="h-12 rounded-[14px] border border-line-2 bg-[rgba(10,14,28,0.6)] px-3 text-[15px]">
          <option value="">{t('music.schedule.wholeLibrary')}</option>
          {(playlists.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.schedule.volume', { v: f.volume })}</span>
          <input type="range" min={5} max={speaker.settings?.volume_max ?? 100} value={f.volume} onChange={(e) => setF({ ...f, volume: Number(e.target.value) })} className="accent-[var(--accent-b)]" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.schedule.stopAfter')}</span>
          <Input type="number" min={0} max={240} value={f.stop_after_min} onChange={(e) => setF({ ...f, stop_after_min: Number(e.target.value) })} className="tabular" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.schedule.fade')}</span>
          <Input type="number" min={0} max={120} value={f.fade_s} onChange={(e) => setF({ ...f, fade_s: Number(e.target.value) })} className="tabular" />
        </label>
      </div>
      <label className="flex items-center gap-3 text-[14.5px]">
        <input type="checkbox" className="h-5 w-5 accent-[var(--accent-a)]" checked={f.shuffle} onChange={(e) => setF({ ...f, shuffle: e.target.checked })} />
        {t('music.player.shuffle')}
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="accent" disabled={busy || !f.name.trim() || f.days === 0}>{t('common.save')}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

function Schedules({ speaker, canWrite }: { speaker: Speaker; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const schedules = useQuery(schedulesQuery(speaker.household_id));
  const playlists = useQuery(playlistsQuery(speaker.household_id));
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const days = t('music.schedule.days').split(',');
  const mine = (schedules.data ?? []).filter((s) => s.device_id === speaker.id);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Moon className="h-5 w-5 text-accent-b" aria-hidden />
        <h2 className="flex-1 font-display text-[18px] font-semibold">{t('music.schedule.title')}</h2>
        {canWrite && editing === null && (
          <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('music.schedule.add')}
          </Button>
        )}
      </div>
      <p className="text-[13.5px] text-muted">{t('music.schedule.intro')}</p>
      {editing === 'new' && <ScheduleForm speaker={speaker} onDone={() => setEditing(null)} />}
      {mine.map((s) =>
        editing === s.id ? (
          <ScheduleForm key={s.id} speaker={speaker} initial={s} onDone={() => setEditing(null)} />
        ) : (
          <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="tabular text-[20px] font-semibold">{s.start_time.slice(0, 5)}</span>
                <span className="truncate text-[15px]">{s.name}</span>
              </div>
              <div className="truncate text-[12.5px] text-muted">
                {DAY_BITS.filter((b) => s.days & b).map((b) => days[DAY_BITS.indexOf(b)]).join(' ')} ·{' '}
                {s.playlist_id ? (playlists.data?.find((p) => p.id === s.playlist_id)?.name ?? '…') : t('music.schedule.wholeLibrary')} ·{' '}
                {t('music.schedule.summary', { v: s.volume, min: s.stop_after_min ?? '–' })}
              </div>
            </div>
            {canWrite && (
              <>
                <label className="flex items-center" title={t('music.schedule.enabled')}>
                  <input type="checkbox" className="h-5 w-5 accent-[var(--accent-a)]" checked={s.enabled} aria-label={t('music.schedule.enabled')}
                    onChange={async (e) => {
                      await saveSchedule({ ...s, enabled: e.target.checked });
                      await invalidateMedia(qc, speaker.household_id, 'schedules');
                    }} />
                </label>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s.id)}>{t('music.schedule.edit')}</Button>
                <Button size="icon" variant="ghost" aria-label={t('music.schedule.delete')}
                  onClick={async () => {
                    await deleteSchedule(s.id);
                    await invalidateMedia(qc, speaker.household_id, 'schedules');
                  }}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </>
            )}
          </div>
        ),
      )}
      {!mine.length && editing === null && <p className="text-[13.5px] text-faint">{t('music.schedule.none')}</p>}
    </Card>
  );
}

function SpeakerPage() {
  const { t } = useTranslation();
  const { deviceId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const isOwner = membership.role === 'owner';
  const navigate = useNavigate();
  const qc = useQueryClient();
  useMediaLive(householdId);
  const speakers = useQuery({ ...speakersQuery(householdId), refetchInterval: 30_000 });
  const tracks = useQuery(tracksQuery(householdId));
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const speaker = speakers.data?.find((s) => s.id === deviceId);
  const when = new Intl.DateTimeFormat(membership.household.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.household.timezone });

  if (speakers.isPending) return <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!speaker) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/settings/devices" className="text-[14px] text-muted">← {t('scale.devices.pageTitle')}</Link>
        <Card className="text-muted">{t('music.speaker.gone')}</Card>
      </div>
    );
  }
  const online = speakerOnline(speaker);
  const st = speaker.status ?? {};
  const songs = (tracks.data ?? []).filter((x) => x.device_id === speaker.id && x.state === 'ready').length;

  async function command(name: 'test_tone' | 'rescan') {
    setTesting(name);
    try {
      const id = await sendMediaCommand(speaker!.id, name);
      const outcome = await waitForMediaCommand(id, 8000);
      if (outcome === 'done') toast.success(t(name === 'test_tone' ? 'music.speaker.tested' : 'music.speaker.rescanned'));
      else toast.error(t('music.errors.noAnswer'));
    } catch (e) {
      toast.error(t(mediaErrorKey(e)));
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings/devices" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('scale.devices.pageTitle')}
      </Link>
      <div className="flex items-center gap-3">
        <span className="brand-gradient flex h-12 w-12 items-center justify-center rounded-2xl text-[#05070F]">
          <SpeakerIcon className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[28px] font-semibold tracking-tight">{speaker.name}</h1>
          <p className={cn('text-[14px]', online ? 'text-teal' : 'text-caution')}>
            {online ? t('music.devices.online') : speaker.last_seen_at ? t('music.speaker.offlineSince', { when: when.format(new Date(speaker.last_seen_at)) }) : t('music.speaker.neverSeen')}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={t('music.speaker.output')} value={st.output ? t(`music.devices.output.${st.output}`) : '–'} />
        <Stat label={t('music.speaker.songs')} value={String(songs)} />
        <Stat label={t('music.speaker.space')} value={st.disk_free_mb != null ? t('music.speaker.free', { gb: (st.disk_free_mb / 1024).toFixed(1) }) : '–'}
          tone={st.disk_free_mb != null && st.disk_free_mb < 500 ? 'text-caution' : undefined} />
        <Stat label={t('music.speaker.temp')} value={st.temp_c != null ? `${Math.round(st.temp_c)} °C` : '–'} tone={st.temp_c != null && st.temp_c > 75 ? 'text-red' : undefined} />
      </div>
      {st.error && <Card className="border-red/40 text-[14px] text-red">{st.error}</Card>}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!online || !!testing} onClick={() => void command('test_tone')}>
            <BellRing className="h-4 w-4" aria-hidden />
            {t('music.speaker.test')}
          </Button>
          <Button variant="secondary" disabled={!online || !!testing} onClick={() => void command('rescan')}>
            <FolderSync className="h-4 w-4" aria-hidden />
            {t('music.speaker.rescan')}
          </Button>
        </div>
      )}

      <SettingsForm key={speaker.settings_version} speaker={speaker} canWrite={canWrite} />
      <NetworkSpeakerCard speaker={speaker} online={online} canWrite={canWrite} />
      <Schedules speaker={speaker} canWrite={canWrite} />

      {isOwner && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-display text-[18px] font-semibold">{t('music.speaker.remove')}</h2>
          <p className="text-[13.5px] text-muted">{t('music.speaker.removeBody')}</p>
          {confirmRemove ? (
            <div className="flex gap-2">
              <Button variant="destructive" onClick={async () => {
                try {
                  await removeSpeaker(speaker.id);
                  await invalidateMedia(qc, householdId);
                  void navigate({ to: '/settings/devices' });
                } catch (e) {
                  toast.error(t(mediaErrorKey(e)));
                }
              }}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('music.speaker.removeConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <Button variant="destructive" className="self-start" onClick={() => setConfirmRemove(true)}>{t('music.speaker.remove')}</Button>
          )}
        </Card>
      )}
    </div>
  );
}
