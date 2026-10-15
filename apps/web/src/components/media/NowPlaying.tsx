// Now playing (Phase 7h): the cover on its aurora, the song, a progress line that runs smoothly
// between the speaker's reports (drag or arrow keys to seek), the transport with the one gold
// Play/Pause, volume (up to the speaker's limit) and the sleep timer with its fade-out.
import { Moon, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { elapsedAt, formatTime, sleepMinutesLeft } from '@/lib/media/progress';
import type { Player, Speaker, Track } from '@/lib/media/queries';
import { cn } from '@/lib/utils';
import { AuroraArt } from './AuroraArt';
import { useNow, type SpeakerView } from './useSpeaker';

export interface NowPlayingProps {
  speaker: Speaker;
  online: boolean;
  player: Player;
  track: Track | null;
  artUrl: string | null;
  canWrite: boolean;
  hasSongs: boolean;
  command: SpeakerView['command'];
  onPlayAll: (shuffle: boolean) => void;
}

function ProgressLine({ player, onSeek, disabled }: { player: Player; onSeek: (s: number) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const now = useNow(player.state === 'playing', 250);
  const [drag, setDrag] = useState<number | null>(null);
  const duration = player.duration_s ?? 0;
  const at = drag ?? elapsedAt(player, now);
  const pct = duration > 0 ? Math.min(100, (at / duration) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="group relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-[5px] -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))', boxShadow: '0 0 12px var(--accent-b)' }}
          />
        </div>
        <div
          aria-hidden
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text shadow-[0_0_0_4px_rgba(255,255,255,0.08)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          style={{ left: `${pct}%` }}
        />
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={1}
          value={Math.round(at)}
          disabled={disabled || duration <= 0}
          aria-label={t('music.player.position')}
          aria-valuetext={`${formatTime(at)} / ${formatTime(duration)}`}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag != null) onSeek(drag);
            setDrag(null);
          }}
          onKeyUp={() => {
            if (drag != null) onSeek(drag);
            setDrag(null);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        />
      </div>
      <div className="tabular flex justify-between text-[12px] text-muted">
        <span>{formatTime(at)}</span>
        <span>{duration > 0 ? `−${formatTime(Math.max(0, duration - at))}` : formatTime(null)}</span>
      </div>
    </div>
  );
}

function VolumeControl({ player, max, onVolume, disabled }: { player: Player; max: number; onVolume: (v: number) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const v = local ?? player.volume;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const Icon = v === 0 ? VolumeX : v < 50 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-3">
      <Icon className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
      <div className="relative h-6 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10">
          <div className="h-full rounded-full bg-white/70" style={{ width: `${(v / 100) * 100}%` }} />
          {max < 100 && <div aria-hidden className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-caution/70" style={{ left: `${max}%` }} />}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={v}
          disabled={disabled}
          aria-label={t('music.player.volume')}
          aria-valuetext={`${v}%`}
          onChange={(e) => {
            const next = Math.min(Number(e.target.value), max);
            setLocal(next);
            // The database keeps only the newest waiting volume change, so a drag sends a few, not dozens.
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              onVolume(next);
              setTimeout(() => setLocal(null), 1500);
            }, 180);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        />
      </div>
      <span className="tabular w-9 text-right text-[12.5px] text-muted">{v}</span>
    </div>
  );
}

const SLEEP = [15, 30, 45, 60] as const;

function SleepChips({ player, onSleep, disabled }: { player: Player; onSleep: (minutes: number, endOfTrack?: boolean) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const now = useNow(!!player.sleep_until, 15_000);
  const left = sleepMinutesLeft(player.sleep_until, now);
  const chip = (active: boolean) =>
    cn(
      'h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium transition-colors',
      active ? 'accent-pill border-transparent text-text' : 'border-line-2 bg-white/[0.03] text-muted hover:text-text',
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Moon className="h-4 w-4" aria-hidden />
        {left != null ? <span className="text-text">{t('music.sleep.left', { count: left })}</span> : t('music.sleep.title')}
      </div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('music.sleep.title')}>
        {SLEEP.map((m) => (
          <button key={m} type="button" disabled={disabled} className={chip(false)} onClick={() => onSleep(m)}>
            {t('music.sleep.minutes', { count: m })}
          </button>
        ))}
        <button type="button" disabled={disabled} className={chip(false)} onClick={() => onSleep(0, true)}>
          {t('music.sleep.endOfSong')}
        </button>
        {left != null && (
          <button type="button" disabled={disabled} className={chip(true)} onClick={() => onSleep(0)}>
            {t('music.sleep.off')}
          </button>
        )}
      </div>
    </div>
  );
}

export function NowPlaying({ speaker, online, player, track, artUrl, canWrite, hasSongs, command, onPlayAll }: NowPlayingProps) {
  const { t } = useTranslation();
  const disabled = !canWrite || !online;
  const playing = player.state === 'playing';
  const max = speaker.settings?.volume_max ?? 100;
  const title = track?.title ?? t('music.player.nothing');
  const RepeatIcon = player.repeat === 'one' ? Repeat1 : Repeat;
  const iconBtn = (active = false) =>
    cn(
      'flex h-12 w-12 items-center justify-center rounded-full transition-colors disabled:opacity-40',
      active ? 'text-accent-b drop-shadow-[0_0_8px_var(--accent-b)]' : 'text-text/85 hover:bg-white/5',
    );

  return (
    <section aria-label={t('music.player.title')} className="glass relative overflow-hidden rounded-[28px] p-5 lg:p-7">
      <div className="flex flex-col items-center gap-6">
        <div className="w-full max-w-[300px] px-4 pt-3 lg:max-w-[340px]" style={{ viewTransitionName: 'music-art' }}>
          <AuroraArt url={artUrl} title={track?.title ?? speaker.name} playing={playing} />
        </div>

        <div className="w-full text-center" aria-live="polite">
          <h2 className="truncate font-display text-[24px] font-semibold leading-tight tracking-tight lg:text-[26px]">{title}</h2>
          <p className="mt-1 truncate text-[14.5px] text-muted">
            {track ? [track.artist, track.album].filter(Boolean).join(' · ') || t('music.library.unknownArtist') : t('music.player.pickBelow')}
          </p>
        </div>

        {track ? (
          <div className="flex w-full flex-col gap-5">
            <ProgressLine player={player} disabled={disabled} onSeek={(s) => void command('seek', { s })} />
            <div className="flex items-center justify-between px-1">
              <button
                type="button"
                className={iconBtn(player.shuffle)}
                disabled={disabled}
                aria-pressed={player.shuffle}
                aria-label={t('music.player.shuffle')}
                onClick={() => void command('shuffle', { on: !player.shuffle })}
              >
                <Shuffle className="h-5 w-5" aria-hidden />
              </button>
              <button type="button" className={iconBtn()} disabled={disabled} aria-label={t('music.player.prev')} onClick={() => void command('prev')}>
                <SkipBack className="h-6 w-6 fill-current" aria-hidden />
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={playing ? t('music.player.pause') : t('music.player.play')}
                onClick={() => void command(playing ? 'pause' : 'resume')}
                className="glow-gold flex h-[76px] w-[76px] items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-50"
              >
                {playing ? <Pause className="h-8 w-8 fill-current" aria-hidden /> : <Play className="ml-1 h-8 w-8 fill-current" aria-hidden />}
              </button>
              <button type="button" className={iconBtn()} disabled={disabled} aria-label={t('music.player.next')} onClick={() => void command('next')}>
                <SkipForward className="h-6 w-6 fill-current" aria-hidden />
              </button>
              <button
                type="button"
                className={iconBtn(player.repeat !== 'off')}
                disabled={disabled}
                aria-label={t(`music.player.repeat.${player.repeat}`)}
                onClick={() => void command('repeat', { mode: player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off' })}
              >
                <RepeatIcon className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <VolumeControl player={player} max={max} disabled={disabled} onVolume={(v) => void command('volume', { v })} />
            <SleepChips
              player={player}
              disabled={disabled}
              onSleep={(minutes, endOfTrack) => void command('sleep', { minutes, end_of_track: !!endOfTrack })}
            />
          </div>
        ) : (
          hasSongs && (
            <div className="flex w-full flex-col items-center gap-3">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPlayAll(false)}
                className="glow-gold flex h-14 items-center gap-2.5 rounded-full px-7 font-display text-[16px] font-semibold disabled:opacity-50"
              >
                <Play className="h-5 w-5 fill-current" aria-hidden />
                {t('music.player.playAll')}
              </button>
              <button type="button" disabled={disabled} onClick={() => onPlayAll(true)} className="flex items-center gap-2 text-[14px] text-muted hover:text-text disabled:opacity-50">
                <Shuffle className="h-4 w-4" aria-hidden />
                {t('music.player.shuffleAll')}
              </button>
            </div>
          )
        )}
      </div>
    </section>
  );
}
