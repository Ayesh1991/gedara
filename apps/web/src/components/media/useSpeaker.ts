// Everything a music screen needs about the household's speaker (Phase 7h): which speaker, what it
// plays, the song, its cover link, and `command()`, which changes the screen at once (optimistic),
// sends the command, waits up to 5 s for the speaker to confirm and otherwise puts the screen back
// and says "The speaker didn't answer". The speaker's own report (Realtime) always wins.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaCommandName } from '@media/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  artQuery,
  emptyPlayer,
  mediaErrorKey,
  optimistic,
  playersQuery,
  sendMediaCommand,
  speakerOnline,
  speakersQuery,
  tracksQuery,
  waitForMediaCommand,
  type Player,
  type Speaker,
  type Track,
} from '@/lib/media/queries';
import { useMediaLive } from './useMediaLive';

const CHOSEN_KEY = 'gedara.music.speaker';

function readChosen(): string | null {
  try {
    return localStorage.getItem(CHOSEN_KEY);
  } catch {
    return null;
  }
}

/** The clock for smooth progress: ticks while `on`. */
export function useNow(on: boolean, everyMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [on, everyMs]);
  return now;
}

export interface SpeakerView {
  speakers: Speaker[];
  speaker: Speaker | null;
  choose: (id: string) => void;
  online: boolean;
  player: Player | null;
  track: Track | null;
  tracks: Track[];
  trackById: Map<string, Track>;
  artUrl: (path: string | null | undefined) => string | null;
  command: (name: MediaCommandName, args?: Record<string, unknown>) => Promise<boolean>;
  loading: boolean;
}

export function useSpeaker(householdId: string): SpeakerView {
  const { t } = useTranslation();
  const qc = useQueryClient();
  useMediaLive(householdId);
  const speakers = useQuery(speakersQuery(householdId));
  const players = useQuery({ ...playersQuery(householdId), refetchInterval: 60_000 });
  const tracksQ = useQuery(tracksQuery(householdId));
  const [chosen, setChosen] = useState<string | null>(readChosen);

  const list = useMemo(() => speakers.data ?? [], [speakers.data]);
  const speaker = list.find((s) => s.id === chosen) ?? list.find((s) => speakerOnline(s)) ?? list[0] ?? null;
  const tracks = useMemo(() => tracksQ.data ?? [], [tracksQ.data]);
  const trackById = useMemo(() => new Map(tracks.map((x) => [x.id, x])), [tracks]);
  const player = speaker ? (players.data?.find((p) => p.device_id === speaker.id) ?? emptyPlayer(speaker.id, householdId)) : null;
  const track = player?.track_id ? (trackById.get(player.track_id) ?? null) : null;

  const artPaths = useMemo(() => tracks.flatMap((x) => (x.art_path ? [x.art_path] : [])), [tracks]);
  const art = useQuery(artQuery(householdId, artPaths));
  const artUrl = useCallback((path: string | null | undefined) => (path ? (art.data?.get(path) ?? null) : null), [art.data]);

  const command = useCallback(
    async (name: MediaCommandName, args: Record<string, unknown> = {}) => {
      if (!speaker) return false;
      const key = playersQuery(householdId).queryKey;
      const before = qc.getQueryData<Player[]>(key);
      const current = before?.find((p) => p.device_id === speaker.id) ?? emptyPlayer(speaker.id, householdId);
      const next = optimistic(current, name, args);
      qc.setQueryData<Player[]>(key, (old) => {
        const rows = old ?? [];
        return rows.some((p) => p.device_id === speaker.id) ? rows.map((p) => (p.device_id === speaker.id ? next : p)) : [...rows, next];
      });
      try {
        const id = await sendMediaCommand(speaker.id, name, args);
        const outcome = await waitForMediaCommand(id, name === 'play' ? 8000 : 5000);
        if (outcome === 'done') return true;
        toast.error(t(outcome === 'failed' ? 'music.errors.speakerFailed' : 'music.errors.noAnswer'));
      } catch (e) {
        toast.error(t(mediaErrorKey(e)));
      }
      // Put the screen back to what the speaker last said.
      await qc.invalidateQueries({ queryKey: key });
      return false;
    },
    [speaker, householdId, qc, t],
  );

  const choose = useCallback((id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(CHOSEN_KEY, id);
    } catch {
      // private mode: the choice lasts until the page is closed
    }
  }, []);

  return {
    speakers: list,
    speaker,
    choose,
    online: speakerOnline(speaker),
    player,
    track,
    tracks,
    trackById,
    artUrl,
    command,
    loading: speakers.isPending || tracksQ.isPending,
  };
}
