// Gedara Music (Phase 7h): the speaker on the Raspberry Pi, played from here. Phone: Now playing,
// Up next and the Library one under the other. Desktop / iPad landscape: Now playing stays in view
// on the left while the library scrolls on the right. Files shared to Gedara on Android
// (Share → Gedara) arrive here ready to upload.
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Music, Speaker as SpeakerIcon, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { EmptyState } from '@/components/aurora/EmptyState';
import { AddMusicSheet } from '@/components/media/AddMusicSheet';
import { Library } from '@/components/media/Library';
import { NowPlaying } from '@/components/media/NowPlaying';
import { QueueList } from '@/components/media/QueueList';
import { useSpeaker } from '@/components/media/useSpeaker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { playlistsQuery } from '@/lib/media/queries';
import { addFiles } from '@/lib/media/upload';
import { takeSharedAudio } from '@/lib/media/shared';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/music/')({
  validateSearch: z.object({ shared: z.coerce.number().optional() }),
  component: MusicPage,
});

function SpeakerChip({ view }: { view: ReturnType<typeof useSpeaker> }) {
  const { t } = useTranslation();
  if (!view.speaker) return null;
  return (
    <div className="flex items-center gap-2">
      {view.speakers.length > 1 ? (
        <select
          value={view.speaker.id}
          onChange={(e) => view.choose(e.target.value)}
          aria-label={t('music.player.speaker')}
          className="glass h-10 rounded-full px-3 text-[13.5px]"
        >
          {view.speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="glass flex h-10 items-center gap-2 rounded-full px-3.5 text-[13.5px]">
          <SpeakerIcon className="h-4 w-4 text-muted" aria-hidden />
          {view.speaker.name}
        </span>
      )}
      <span
        className={cn('h-2.5 w-2.5 rounded-full', view.online ? 'bg-teal shadow-[0_0_10px_var(--teal)]' : 'bg-caution')}
        title={view.online ? t('music.devices.online') : t('music.devices.offline')}
        aria-label={view.online ? t('music.devices.online') : t('music.devices.offline')}
      />
    </div>
  );
}

function MusicPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { shared } = Route.useSearch();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const isOwner = membership.role === 'owner';
  const view = useSpeaker(householdId);
  const playlists = useQuery(playlistsQuery(householdId));
  const [adding, setAdding] = useState(false);

  // Android Share → Gedara: the service worker kept the files; queue them for this speaker.
  useEffect(() => {
    if (!shared || !view.speaker || !canWrite) return;
    void takeSharedAudio().then((files) => {
      if (!files.length) return;
      addFiles(files, view.speaker!.id, householdId);
      setAdding(true);
    });
  }, [shared, view.speaker, canWrite, householdId]);

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="flex-1 font-display text-[30px] font-semibold tracking-tight">{t('music.title')}</h1>
      <SpeakerChip view={view} />
    </div>
  );

  if (view.loading) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="glass h-[520px] animate-pulse rounded-[28px]" aria-hidden />
      </div>
    );
  }

  if (!view.speaker) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <EmptyState
          icon={Music}
          title={t('music.empty.noSpeakerTitle')}
          body={t('music.empty.noSpeakerBody')}
          action={
            isOwner ? (
              <Link to="/settings/devices" className="text-accent-b underline">
                {t('music.empty.setUp')}
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  const mine = view.tracks.filter((x) => x.device_id === view.speaker!.id);
  const readyIds = mine.filter((x) => x.state === 'ready').map((x) => x.id);

  return (
    <div className="flex flex-col gap-5">
      {header}
      {!view.online && (
        <Card className="flex items-center gap-3 border-caution/40 py-3.5 text-[14px]">
          <WifiOff className="h-5 w-5 shrink-0 text-caution" aria-hidden />
          <span className="text-[#c9d0e6]">
            {view.speaker.last_seen_at
              ? t('music.offline.since', {
                  when: new Intl.DateTimeFormat(membership.household.locale, { timeStyle: 'short', dateStyle: 'medium', timeZone: membership.household.timezone }).format(
                    new Date(view.speaker.last_seen_at),
                  ),
                })
              : t('music.offline.never')}
          </span>
        </Card>
      )}

      {mine.length === 0 ? (
        <EmptyState
          icon={Music}
          title={t('music.empty.noSongsTitle')}
          body={t('music.empty.noSongsBody')}
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                {t('music.add.button')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(340px,420px)_1fr] lg:items-start">
          <div className="flex flex-col gap-6 lg:sticky lg:top-6">
            <NowPlaying
              speaker={view.speaker}
              online={view.online}
              player={view.player!}
              track={view.track}
              artUrl={view.artUrl(view.track?.art_path)}
              canWrite={canWrite}
              hasSongs={readyIds.length > 0}
              command={view.command}
              onPlayAll={(shuffle) => void view.command('play', { track_ids: readyIds, index: 0, shuffle })}
            />
            <QueueList view={view} canWrite={canWrite} />
          </div>
          <Library householdId={householdId} view={view} playlists={playlists.data ?? []} canWrite={canWrite} onAddMusic={() => setAdding(true)} />
        </div>
      )}

      {adding && (
        <AddMusicSheet open onClose={() => setAdding(false)} deviceId={view.speaker.id} householdId={householdId} speakerName={view.speaker.name} />
      )}
    </div>
  );
}
