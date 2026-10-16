// The mini player (Phase 7h): while the speaker plays or is paused, a glass bar floats above the
// phone's dock (a card bottom-right on desktop) on every Gedara screen except Music itself. Cover,
// song, play/pause and a hairline of progress; tapping it opens Music, and the cover grows into the
// big one (View Transitions where the browser has them, a plain fade elsewhere). It leaves room at
// the end of the page so it never covers the last row.
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Airplay, Bluetooth, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fraction } from '@/lib/media/progress';
import { externalSource, speakersQuery } from '@/lib/media/queries';
import { Cover } from './AuroraArt';
import { PlayingBars } from './Library';
import { useNow, useSpeaker } from './useSpeaker';

/** Nothing at all (no song list, no live channel) for a household without a speaker. */
export function MiniPlayer({ householdId, canWrite }: { householdId: string; canWrite: boolean }) {
  const speakers = useQuery(speakersQuery(householdId));
  return speakers.data?.length ? <Bar householdId={householdId} canWrite={canWrite} /> : null;
}

function Bar({ householdId, canWrite }: { householdId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const view = useSpeaker(householdId);
  const p = view.player;
  const playing = p?.state === 'playing';
  const now = useNow(playing, 1000);
  if (!view.speaker || !p || pathname.startsWith('/music')) return null;
  const external = externalSource(p);
  if (!external && (!view.track || p.state === 'stopped')) return null;

  const open = () => {
    const go = () => void navigate({ to: '/music' });
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(go);
    else go();
  };

  const shell =
    'glass-strong fixed inset-x-3.5 bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+1.6rem)] z-30 overflow-hidden rounded-[22px] shadow-[0_18px_50px_-18px_rgba(0,0,0,0.95)] lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-[380px]';

  // A phone plays over AirPlay / Bluetooth (Phase 7i): say who; Music has the take-over.
  const song = view.track;
  if (external || !song) {
    const Icon = p.source === 'airplay' ? Airplay : Bluetooth;
    return (
      <>
        <div aria-hidden className="h-20 lg:hidden" />
        <div className={shell} data-testid="mini-player">
          <button type="button" onClick={open} className="flex h-[64px] w-full items-center gap-3 px-3 text-left">
            <span className="brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#05070F]">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-semibold">{t(`music.external.${p.source as 'airplay' | 'bluetooth'}`)}</span>
              <span className="block truncate text-[12.5px] text-muted">
                {p.source_name ?? t('music.external.aPhone')} · {view.speaker.name}
              </span>
            </span>
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <div aria-hidden className="h-20 lg:hidden" />
      <div className={shell} data-testid="mini-player">
        <div className="flex h-[64px] items-center gap-3 pr-2 pl-2.5">
          <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={t('music.mini.open', { title: song.title })}>
            <span style={{ viewTransitionName: 'music-art' }} className="shrink-0">
              <Cover url={view.artUrl(song.art_path)} title={song.title} className="h-11 w-11" rounded="rounded-xl" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[14.5px] font-semibold">{song.title}</span>
                {playing && <PlayingBars playing />}
              </span>
              <span className="block truncate text-[12.5px] text-muted">
                {song.artist ?? t('music.library.unknownArtist')} · {view.speaker.name}
              </span>
            </span>
          </button>
          <button
            type="button"
            disabled={!canWrite || !view.online}
            onClick={() => void view.command(playing ? 'pause' : 'resume')}
            aria-label={playing ? t('music.player.pause') : t('music.player.play')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-text text-ink transition-transform active:scale-95 disabled:opacity-40"
          >
            {playing ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden />}
          </button>
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-white/5">
          <div className="h-full" style={{ width: `${fraction(p, now) * 100}%`, background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))' }} />
        </div>
      </div>
    </>
  );
}
