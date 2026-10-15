// One playlist (Phase 7h): its cover mosaic, Play (gold) and Shuffle, the songs in order (move up /
// down, take out), rename and delete. Songs are added from the library's ⋯ menu.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronLeft, Pencil, Play, Shuffle, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Cover } from '@/components/media/AuroraArt';
import { Mosaic } from '@/components/media/Library';
import { useSpeaker } from '@/components/media/useSpeaker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatLength, formatTime } from '@/lib/media/progress';
import { deletePlaylist, invalidateMedia, mediaErrorKey, playlistsQuery, renamePlaylist, setPlaylistTracks, type Track } from '@/lib/media/queries';

export const Route = createFileRoute('/_app/music/playlist/$playlistId')({
  component: PlaylistPage,
});

function PlaylistPage() {
  const { t } = useTranslation();
  const { playlistId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const view = useSpeaker(householdId);
  const playlists = useQuery(playlistsQuery(householdId));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pl = playlists.data?.find((p) => p.id === playlistId);

  if (playlists.isPending) return <div className="glass h-60 animate-pulse rounded-[28px]" aria-hidden />;
  if (!pl) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/music" className="text-[14px] text-muted">← {t('music.title')}</Link>
        <Card className="text-muted">{t('music.playlists.gone')}</Card>
      </div>
    );
  }

  const songs = pl.trackIds.map((id) => view.trackById.get(id)).filter((x): x is Track => !!x);
  const ready = songs.filter((x) => x.state === 'ready' && x.device_id === view.speaker?.id);
  const total = songs.reduce((s, x) => s + (x.duration_s ?? 0), 0);
  const disabled = !canWrite || !view.online || !ready.length;

  async function reorder(ids: string[]) {
    try {
      await setPlaylistTracks(pl!.id, ids);
      await invalidateMedia(qc, householdId, 'playlists');
    } catch (e) {
      toast.error(t(mediaErrorKey(e)));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link to="/music" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('music.title')}
      </Link>

      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-end">
        <Mosaic trackIds={pl.trackIds} view={view} name={pl.name} className="h-44 w-44 shrink-0 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.95)]" />
        <div className="flex min-w-0 flex-1 flex-col items-center gap-3 sm:items-start">
          {renaming != null ? (
            <form
              className="flex w-full gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await renamePlaylist(pl.id, renaming);
                  await invalidateMedia(qc, householdId, 'playlists');
                  setRenaming(null);
                } catch (err) {
                  toast.error(t(mediaErrorKey(err)));
                }
              }}
            >
              <Input value={renaming} maxLength={60} onChange={(e) => setRenaming(e.target.value)} aria-label={t('music.playlists.newName')} autoFocus />
              <Button type="submit" variant="accent" disabled={!renaming.trim()}>{t('common.save')}</Button>
            </form>
          ) : (
            <h1 className="flex items-center gap-2 font-display text-[30px] font-semibold tracking-tight">
              {pl.name}
              {canWrite && (
                <button type="button" onClick={() => setRenaming(pl.name)} aria-label={t('music.playlists.rename')} className="text-muted hover:text-text">
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
              )}
            </h1>
          )}
          <p className="tabular text-[13.5px] text-muted">
            {t('music.library.songs', { count: songs.length })} · {formatLength(total, { h: t('music.units.h'), min: t('music.units.min') })}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void view.command('play', { playlist_id: pl.id, track_ids: ready.map((x) => x.id), index: 0 })}
              className="glow-gold flex h-14 items-center gap-2.5 rounded-full px-7 font-display text-[16px] font-semibold disabled:opacity-50"
            >
              <Play className="h-5 w-5 fill-current" aria-hidden />
              {t('music.player.play')}
            </button>
            <Button variant="secondary" disabled={disabled} onClick={() => void view.command('play', { playlist_id: pl.id, track_ids: ready.map((x) => x.id), index: 0, shuffle: true })}>
              <Shuffle className="h-4 w-4" aria-hidden />
              {t('music.player.shuffle')}
            </Button>
          </div>
        </div>
      </div>

      {songs.length ? (
        <ol className="flex flex-col">
          {songs.map((x, i) => (
            <li key={x.id} className="flex items-center gap-3 rounded-2xl px-2 py-1.5 hover:bg-white/[0.04]">
              <span className="tabular w-6 text-right text-[13px] text-faint">{i + 1}</span>
              <button
                type="button"
                disabled={disabled || x.state !== 'ready'}
                onClick={() => void view.command('play', { track_ids: ready.map((r) => r.id), index: Math.max(0, ready.findIndex((r) => r.id === x.id)) })}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={t('music.library.playSong', { title: x.title })}
              >
                <Cover url={view.artUrl(x.art_path)} title={x.title} className="h-11 w-11 shrink-0" rounded="rounded-xl" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{x.title}</span>
                  <span className="block truncate text-[12.5px] text-muted">{x.artist ?? t('music.library.unknownArtist')}</span>
                </span>
                <span className="tabular text-[12.5px] text-faint">{formatTime(x.duration_s)}</span>
              </button>
              {canWrite && (
                <span className="flex">
                  <button type="button" disabled={i === 0} aria-label={t('music.queue.up')} className="flex h-10 w-9 items-center justify-center text-muted disabled:opacity-30"
                    onClick={() => {
                      const ids = [...pl.trackIds];
                      [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
                      void reorder(ids);
                    }}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" disabled={i === songs.length - 1} aria-label={t('music.queue.down')} className="flex h-10 w-9 items-center justify-center text-muted disabled:opacity-30"
                    onClick={() => {
                      const ids = [...pl.trackIds];
                      [ids[i + 1], ids[i]] = [ids[i]!, ids[i + 1]!];
                      void reorder(ids);
                    }}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" aria-label={t('music.playlists.removeSong', { title: x.title })} className="flex h-10 w-9 items-center justify-center text-muted"
                    onClick={() => void reorder(pl.trackIds.filter((id) => id !== x.id))}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <Card className="text-[14px] text-muted">{t('music.playlists.noSongs')}</Card>
      )}

      {canWrite && (
        <div className="flex gap-2">
          {confirmDelete ? (
            <>
              <Button variant="destructive" onClick={async () => {
                try {
                  await deletePlaylist(pl.id);
                  await invalidateMedia(qc, householdId, 'playlists');
                  void navigate({ to: '/music' });
                } catch (e) {
                  toast.error(t(mediaErrorKey(e)));
                }
              }}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('music.playlists.deleteConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            </>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>{t('music.playlists.delete')}</Button>
          )}
        </div>
      )}
    </div>
  );
}
