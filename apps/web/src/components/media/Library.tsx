// The speaker's library (Phase 7h): Songs, Albums, Artists and Playlists with one search box.
// Tapping a song plays it with the rest of the list after it; the ⋯ button (or a long press) opens
// the song's actions in a bottom sheet, within one thumb's reach: play next, add to the queue, add
// to a playlist, edit its details, delete it from the speaker. Songs on their way show where they
// are (uploading → on its way → on the speaker).
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, ListMusic, ListPlus, LoaderCircle, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatLength, formatTime } from '@/lib/media/progress';
import {
  albumsOf,
  byAlbum,
  createPlaylist,
  deleteTracks,
  invalidateMedia,
  mediaErrorKey,
  setPlaylistTracks,
  updateTrack,
  type Playlist,
  type Track,
} from '@/lib/media/queries';
import { cn } from '@/lib/utils';
import { Cover } from './AuroraArt';
import type { SpeakerView } from './useSpeaker';

type Tab = 'songs' | 'albums' | 'artists' | 'playlists';

function matches(t: Track, q: string) {
  if (!q) return true;
  const s = `${t.title} ${t.artist ?? ''} ${t.album ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => s.includes(w));
}

/** Three bars that dance while this song plays (still when motion is off). */
export function PlayingBars({ playing }: { playing: boolean }) {
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-full bg-accent-b', playing && 'motion-safe:animate-[eq_0.9s_ease-in-out_infinite]')}
          style={{ height: playing ? undefined : `${[55, 85, 40][i]}%`, animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

function StateBadge({ track }: { track: Track }) {
  const { t } = useTranslation();
  if (track.state === 'ready') return null;
  if (track.state === 'failed') {
    return (
      <span className="flex items-center gap-1 text-[12px] text-red" title={track.error ?? undefined}>
        <CircleAlert className="h-3.5 w-3.5" aria-hidden />
        {t('music.state.failed')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[12px] text-due">
      <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
      {t(`music.state.${track.state}`)}
    </span>
  );
}

function SongRow({
  track,
  art,
  current,
  playing,
  onPlay,
  onMore,
}: {
  track: Track;
  art: string | null;
  current: boolean;
  playing: boolean;
  onPlay: () => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = track.state === 'ready';
  return (
    <li className={cn('group flex items-center gap-3 rounded-2xl px-2 py-1.5 transition-colors', current ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]')}>
      <button
        type="button"
        disabled={!ready}
        onClick={onPlay}
        onContextMenu={(e) => {
          e.preventDefault();
          onMore();
        }}
        onPointerDown={() => {
          press.current = setTimeout(onMore, 550);
        }}
        onPointerUp={() => press.current && clearTimeout(press.current)}
        onPointerLeave={() => press.current && clearTimeout(press.current)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        aria-label={t('music.library.playSong', { title: track.title })}
      >
        <span className="relative shrink-0">
          <Cover url={art} title={track.title} className={cn('h-12 w-12', !ready && 'opacity-50')} rounded="rounded-xl" />
          {current && (
            <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45">
              <PlayingBars playing={playing} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[15px] font-medium', current && 'text-accent-b')}>{track.title}</span>
          <span className="flex items-center gap-2 truncate text-[13px] text-muted">
            {ready ? (track.artist ?? t('music.library.unknownArtist')) : <StateBadge track={track} />}
          </span>
        </span>
        <span className="tabular shrink-0 text-[12.5px] text-faint">{formatTime(track.duration_s)}</span>
      </button>
      <button
        type="button"
        onClick={onMore}
        aria-label={t('music.library.more', { title: track.title })}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-white/5 hover:text-text"
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>
    </li>
  );
}

function SongList({
  tracks,
  view,
  canWrite,
  onMore,
}: {
  tracks: Track[];
  view: SpeakerView;
  canWrite: boolean;
  onMore: (t: Track) => void;
}) {
  const ready = tracks.filter((t) => t.state === 'ready');
  return (
    <ul className="flex flex-col">
      {tracks.map((tr) => (
        <SongRow
          key={tr.id}
          track={tr}
          art={view.artUrl(tr.art_path)}
          current={view.player?.track_id === tr.id && view.player.state !== 'stopped'}
          playing={view.player?.track_id === tr.id && view.player.state === 'playing'}
          onMore={() => onMore(tr)}
          onPlay={() => {
            if (!canWrite || !view.online) return;
            void view.command('play', { track_ids: ready.map((x) => x.id), index: Math.max(0, ready.findIndex((x) => x.id === tr.id)) });
          }}
        />
      ))}
    </ul>
  );
}

function SongActions({
  track,
  householdId,
  playlists,
  view,
  canWrite,
  onClose,
}: {
  track: Track;
  householdId: string;
  playlists: Playlist[];
  view: SpeakerView;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'menu' | 'edit' | 'playlist' | 'delete'>('menu');
  const [form, setForm] = useState({ title: track.title, artist: track.artist ?? '', album: track.album ?? '' });
  const [newList, setNewList] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = track.state === 'ready';

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      // A speaker command reports its own failure (and returns false): no "done" toast then.
      if ((await fn()) === false) return;
      if (done) toast.success(done);
      await invalidateMedia(qc, householdId);
      onClose();
    } catch (e) {
      toast.error(t(mediaErrorKey(e)));
    } finally {
      setBusy(false);
    }
  }

  const action = (icon: ReactNode, label: string, onClick: () => void, disabled = false, danger = false) => (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className={cn('flex h-14 items-center gap-3.5 rounded-2xl px-3 text-left text-[15.5px] hover:bg-white/5 disabled:opacity-40', danger && 'text-red')}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Sheet open onClose={onClose} title={track.title}>
      {mode === 'menu' && (
        <div className="flex flex-col">
          <div className="mb-2 flex items-center gap-3">
            <Cover url={view.artUrl(track.art_path)} title={track.title} className="h-14 w-14" rounded="rounded-xl" />
            <div className="min-w-0 text-[13.5px] text-muted">
              <div className="truncate">{[track.artist, track.album].filter(Boolean).join(' · ') || t('music.library.unknownArtist')}</div>
              <div className="tabular">
                {formatTime(track.duration_s)} · {t(`music.source.${track.source}`)} · {t('music.library.plays', { count: track.plays })}
              </div>
            </div>
          </div>
          {action(<ListPlus className="h-5 w-5 text-muted" aria-hidden />, t('music.actions.playNext'),
            () => void run(() => view.command('queue_add', { track_ids: [track.id], next: true }), t('music.actions.addedNext')), !canWrite || !ready || !view.online)}
          {action(<ListMusic className="h-5 w-5 text-muted" aria-hidden />, t('music.actions.addToQueue'),
            () => void run(() => view.command('queue_add', { track_ids: [track.id], next: false }), t('music.actions.addedQueue')), !canWrite || !ready || !view.online)}
          {action(<Plus className="h-5 w-5 text-muted" aria-hidden />, t('music.actions.addToPlaylist'), () => setMode('playlist'), !canWrite)}
          {action(<Pencil className="h-5 w-5 text-muted" aria-hidden />, t('music.actions.edit'), () => setMode('edit'), !canWrite)}
          {action(<Trash2 className="h-5 w-5" aria-hidden />, t('music.actions.delete'), () => setMode('delete'), !canWrite, true)}
        </div>
      )}

      {mode === 'edit' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => updateTrack(track.id, { title: form.title, artist: form.artist || null, album: form.album || null }), t('music.actions.saved'));
          }}
        >
          {(['title', 'artist', 'album'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1.5 text-[13px] text-muted">
              {t(`music.fields.${k}`)}
              <Input value={form[k]} required={k === 'title'} maxLength={200} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </label>
          ))}
          <Button type="submit" variant="accent" disabled={busy || !form.title.trim()}>
            {t('common.save')}
          </Button>
        </form>
      )}

      {mode === 'playlist' && (
        <div className="flex flex-col gap-2">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              disabled={busy || pl.trackIds.includes(track.id)}
              onClick={() => void run(() => setPlaylistTracks(pl.id, [...pl.trackIds, track.id]), t('music.actions.addedTo', { name: pl.name }))}
              className="flex h-12 items-center justify-between rounded-2xl px-3 text-left text-[15px] hover:bg-white/5 disabled:opacity-50"
            >
              <span className="truncate">{pl.name}</span>
              <span className="tabular text-[12.5px] text-faint">
                {pl.trackIds.includes(track.id) ? t('music.actions.alreadyIn') : t('music.library.songs', { count: pl.trackIds.length })}
              </span>
            </button>
          ))}
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => createPlaylist(householdId, newList, [track.id]), t('music.actions.addedTo', { name: newList.trim() }));
            }}
          >
            <Input value={newList} onChange={(e) => setNewList(e.target.value)} maxLength={60} placeholder={t('music.playlists.newName')} aria-label={t('music.playlists.newName')} />
            <Button type="submit" variant="accent" disabled={busy || !newList.trim()}>
              {t('music.playlists.create')}
            </Button>
          </form>
        </div>
      )}

      {mode === 'delete' && (
        <div className="flex flex-col gap-4">
          <p className="text-[14.5px] leading-relaxed text-[#a5b0d0]">
            {t(track.source === 'pc' ? 'music.actions.deletePcBody' : 'music.actions.deleteBody', { title: track.title })}
          </p>
          <Button variant="destructive" disabled={busy} onClick={() => void run(() => deleteTracks([track.id]), t('music.actions.deleted'))}>
            {t('music.actions.deleteConfirm')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function Library({
  householdId,
  view,
  playlists,
  canWrite,
  onAddMusic,
}: {
  householdId: string;
  view: SpeakerView;
  playlists: Playlist[];
  canWrite: boolean;
  onAddMusic: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('songs');
  const [q, setQ] = useState('');
  const [album, setAlbum] = useState<string | null>(null);
  const [artist, setArtist] = useState<string | null>(null);
  const [acting, setActing] = useState<Track | null>(null);
  const qc = useQueryClient();

  const mine = useMemo(() => view.tracks.filter((x) => !view.speaker || x.device_id === view.speaker.id), [view.tracks, view.speaker]);
  const found = useMemo(() => mine.filter((x) => matches(x, q)), [mine, q]);
  const albums = useMemo(() => albumsOf(found), [found]);
  const artists = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const x of found) m.set(x.artist ?? t('music.library.unknownArtist'), [...(m.get(x.artist ?? t('music.library.unknownArtist')) ?? []), x]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [found, t]);

  const tabBtn = (k: Tab) => (
    <button
      key={k}
      type="button"
      role="tab"
      aria-selected={tab === k}
      onClick={() => {
        setTab(k);
        setAlbum(null);
        setArtist(null);
      }}
      className={cn('h-10 shrink-0 rounded-full px-4 text-[14px] font-medium transition-colors', tab === k ? 'accent-pill text-text' : 'text-muted hover:text-text')}
    >
      {t(`music.library.tabs.${k}`)}
    </button>
  );

  const total = mine.reduce((s, x) => s + (x.duration_s ?? 0), 0);

  return (
    <section aria-label={t('music.library.title')} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h2 className="font-display text-[22px] font-semibold">{t('music.library.title')}</h2>
          {mine.length > 0 && (
            <p className="tabular text-[13px] text-muted">
              {t('music.library.songs', { count: mine.length })} · {formatLength(total, { h: t('music.units.h'), min: t('music.units.min') })}
            </p>
          )}
        </div>
        {canWrite && (
          <Button variant="accent" size="sm" onClick={onAddMusic}>
            <Upload className="h-4 w-4" aria-hidden />
            {t('music.add.button')}
          </Button>
        )}
      </div>

      <label className="glass flex h-12 items-center gap-2.5 rounded-2xl px-3.5">
        <Search className="h-[18px] w-[18px] text-muted" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('music.library.search')}
          aria-label={t('music.library.search')}
          className="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
      </label>

      <div role="tablist" aria-label={t('music.library.title')} className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
        {(['songs', 'albums', 'artists', 'playlists'] as Tab[]).map(tabBtn)}
      </div>

      {tab === 'songs' &&
        (found.length ? (
          <SongList tracks={found} view={view} canWrite={canWrite} onMore={setActing} />
        ) : (
          <p className="py-6 text-center text-[14px] text-muted">{q ? t('music.library.noMatch') : t('music.library.empty')}</p>
        ))}

      {tab === 'albums' &&
        (album ? (
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => setAlbum(null)} className="self-start text-[14px] text-muted hover:text-text">
              ← {t('music.library.tabs.albums')}
            </button>
            <SongList tracks={albums.find((a) => a.key === album)?.tracks ?? []} view={view} canWrite={canWrite} onMore={setActing} />
          </div>
        ) : albums.length ? (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {albums.map((a) => (
              <li key={a.key}>
                <button type="button" onClick={() => setAlbum(a.key)} className="group flex w-full flex-col gap-2 text-left">
                  <Cover url={view.artUrl(a.art_path)} title={a.name} className="aspect-square w-full transition-transform group-hover:scale-[1.02]" rounded="rounded-2xl" />
                  <span className="min-w-0">
                    <span className="block truncate text-[14.5px] font-medium">{a.name}</span>
                    <span className="block truncate text-[12.5px] text-muted">{a.artist ?? t('music.library.unknownArtist')} · {t('music.library.songs', { count: a.tracks.length })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-[14px] text-muted">{t('music.library.noAlbums')}</p>
        ))}

      {tab === 'artists' &&
        (artist ? (
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => setArtist(null)} className="self-start text-[14px] text-muted hover:text-text">
              ← {t('music.library.tabs.artists')}
            </button>
            <SongList tracks={[...(artists.find(([n]) => n === artist)?.[1] ?? [])].sort(byAlbum)} view={view} canWrite={canWrite} onMore={setActing} />
          </div>
        ) : (
          <ul className="flex flex-col">
            {artists.map(([name, list]) => (
              <li key={name}>
                <button type="button" onClick={() => setArtist(name)} className="flex h-14 w-full items-center gap-3 rounded-2xl px-2 text-left hover:bg-white/[0.04]">
                  <Cover url={view.artUrl(list.find((x) => x.art_path)?.art_path)} title={name} className="h-11 w-11" rounded="rounded-full" />
                  <span className="flex-1 truncate text-[15px]">{name}</span>
                  <span className="tabular text-[12.5px] text-faint">{t('music.library.songs', { count: list.length })}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'playlists' && (
        <Playlists householdId={householdId} playlists={playlists} view={view} canWrite={canWrite} onCreated={() => void invalidateMedia(qc, householdId, 'playlists')} />
      )}

      {acting && (
        <SongActions track={acting} householdId={householdId} playlists={playlists} view={view} canWrite={canWrite} onClose={() => setActing(null)} />
      )}
    </section>
  );
}

/** A 2×2 mosaic of a playlist's first covers. */
export function Mosaic({ trackIds, view, name, className }: { trackIds: string[]; view: SpeakerView; name: string; className?: string }) {
  const arts = trackIds
    .map((id) => view.trackById.get(id))
    .filter((x): x is Track => !!x)
    .slice(0, 4);
  if (arts.length < 4) return <Cover url={view.artUrl(arts[0]?.art_path)} title={name} className={className} rounded="rounded-2xl" />;
  return (
    <div className={cn('grid grid-cols-2 grid-rows-2 overflow-hidden rounded-2xl', className)}>
      {arts.map((x) => (
        <Cover key={x.id} url={view.artUrl(x.art_path)} title={x.title} className="h-full w-full" rounded="rounded-none" />
      ))}
    </div>
  );
}

function Playlists({
  householdId,
  playlists,
  view,
  canWrite,
  onCreated,
}: {
  householdId: string;
  playlists: Playlist[];
  view: SpeakerView;
  canWrite: boolean;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await createPlaylist(householdId, name);
              setName('');
              onCreated();
            } catch (err) {
              toast.error(t(mediaErrorKey(err)));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('music.playlists.newName')} aria-label={t('music.playlists.newName')} />
          <Button type="submit" variant="accent" disabled={busy || !name.trim()}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('music.playlists.create')}
          </Button>
        </form>
      )}
      {playlists.length ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {playlists.map((pl) => (
            <li key={pl.id}>
              <Link to="/music/playlist/$playlistId" params={{ playlistId: pl.id }} className="group flex flex-col gap-2">
                <Mosaic trackIds={pl.trackIds} view={view} name={pl.name} className="aspect-square w-full transition-transform group-hover:scale-[1.02]" />
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-medium">{pl.name}</span>
                  <span className="block text-[12.5px] text-muted">{t('music.library.songs', { count: pl.trackIds.length })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-[14px] text-muted">{t('music.playlists.empty')}</p>
      )}
    </div>
  );
}
