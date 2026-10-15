// Gedara Music data access (Phase 7h). Reads straight from the tables (RLS: members read); songs,
// commands and playlist order change through RPCs, playlists and schedules are plain rows
// (can_write policies, migration 71). The speaker itself only talks to the media-agent function.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { MediaCommandName, MediaMime, PlayerState, RepeatMode } from '@media/protocol';
import type { Json } from '../db.types';
import { supabase } from '../supabase';

export const mediaKey = (householdId: string, ...rest: unknown[]) => ['media', householdId, ...rest] as const;

export function invalidateMedia(qc: QueryClient, householdId: string, what?: 'tracks' | 'playlists' | 'player' | 'speakers' | 'schedules') {
  return qc.invalidateQueries({ queryKey: what ? mediaKey(householdId, what) : mediaKey(householdId) });
}

// ── Speakers ──────────────────────────────────────────────────────────────────
export interface SpeakerSettings {
  volume_max: number;
  fade_s: number;
  normalise: boolean;
}

export interface SpeakerStatus {
  output?: 'usb' | 'jack' | 'none';
  disk_free_mb?: number;
  disk_total_mb?: number;
  temp_c?: number;
  mpd?: boolean;
  files?: number;
  error?: string | null;
  up?: number;
}

export interface Speaker {
  id: string;
  household_id: string;
  name: string;
  token_hint: string;
  settings: SpeakerSettings;
  settings_version: number;
  last_seen_at: string | null;
  fw_version: string | null;
  status: SpeakerStatus | null;
  created_at: string;
  revoked_at: string | null;
}

const SPEAKER_COLUMNS = 'id, household_id, name, token_hint, settings, settings_version, last_seen_at, fw_version, status, created_at, revoked_at';

export const speakersQuery = (householdId: string) =>
  queryOptions({
    queryKey: mediaKey(householdId, 'speakers'),
    queryFn: async (): Promise<Speaker[]> => {
      const { data, error } = await supabase
        .from('device')
        .select(SPEAKER_COLUMNS)
        .eq('household_id', householdId)
        .eq('kind', 'media')
        .is('revoked_at', null)
        .order('created_at');
      if (error) throw error;
      return data as unknown as Speaker[];
    },
    staleTime: 15_000,
  });

/** The speaker counts as online if it was heard from in the last 90 s (it long-polls every 25 s). */
export function speakerOnline(s: Pick<Speaker, 'last_seen_at'> | null | undefined, now = Date.now()): boolean {
  return !!s?.last_seen_at && now - Date.parse(s.last_seen_at) < 90_000;
}

export type PairResult = { ok: true; id: string } | { ok: false; error: 'GDPCN' };

export async function pairSpeaker(householdId: string, code: string, name: string): Promise<PairResult> {
  const { data, error } = await supabase.rpc('rpc_device_pair', { p_household: householdId, p_code: code, p_name: name });
  if (error) throw error;
  return data as unknown as PairResult;
}

export async function updateSpeaker(id: string, p: { name?: string; settings?: Partial<SpeakerSettings> }): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_update', { p_id: id, p: p as Json });
  if (error) throw error;
}

export async function removeSpeaker(id: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_device_revoke', { p_id: id });
  if (error) throw error;
}

// ── Songs ─────────────────────────────────────────────────────────────────────
export type TrackState = 'uploading' | 'waiting' | 'downloading' | 'ready' | 'failed' | 'deleting';

export interface Track {
  id: string;
  household_id: string;
  device_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  track_no: number | null;
  duration_s: number | null;
  size_bytes: number;
  sha256: string;
  mime: MediaMime;
  source: 'upload' | 'pc';
  state: TrackState;
  on_device: boolean;
  error: string | null;
  art_path: string | null;
  file_name: string | null;
  plays: number;
  last_played_at: string | null;
  created_at: string;
}

const TRACK_COLUMNS = `id, household_id, device_id, title, artist, album, track_no, duration_s, size_bytes, sha256, mime, source,
  state, on_device, error, art_path, file_name, plays, last_played_at, created_at`;

export const tracksQuery = (householdId: string) =>
  queryOptions({
    queryKey: mediaKey(householdId, 'tracks'),
    queryFn: async (): Promise<Track[]> => {
      const { data, error } = await supabase
        .from('media_track')
        .select(TRACK_COLUMNS)
        .eq('household_id', householdId)
        .neq('state', 'deleting')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data as unknown as Track[]).map((t) => ({ ...t, duration_s: t.duration_s == null ? null : Number(t.duration_s) }));
    },
    staleTime: 30_000,
  });

export async function updateTrack(id: string, p: { title?: string; artist?: string | null; album?: string | null; track_no?: number | null }) {
  const { error } = await supabase.rpc('rpc_media_track_update', { p_id: id, p: p as Json });
  if (error) throw error;
}

export async function deleteTracks(ids: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('rpc_media_track_delete', { p_ids: ids });
  if (error) throw error;
  return data as number;
}

/** Library order: album, then track number, then title (songs without an album last). */
export function byAlbum(a: Track, b: Track): number {
  const aa = a.album ?? '￿';
  const ba = b.album ?? '￿';
  if (aa !== ba) return aa.localeCompare(ba);
  if ((a.track_no ?? 999) !== (b.track_no ?? 999)) return (a.track_no ?? 999) - (b.track_no ?? 999);
  return a.title.localeCompare(b.title);
}

export interface Album {
  key: string;
  name: string;
  artist: string | null;
  art_path: string | null;
  tracks: Track[];
}

export function albumsOf(tracks: Track[]): Album[] {
  const map = new Map<string, Album>();
  for (const t of [...tracks].sort(byAlbum)) {
    if (!t.album) continue;
    const key = `${t.album}\u0000${t.artist ?? ''}`;
    const a = map.get(key) ?? { key, name: t.album, artist: t.artist, art_path: null, tracks: [] };
    a.tracks.push(t);
    a.art_path ??= t.art_path;
    map.set(key, a);
  }
  return [...map.values()];
}

// ── Cover art (signed links, cached until shortly before they expire) ─────────
const ART_SECONDS = 3600;
const artCache = new Map<string, { url: string; until: number }>();

export async function signArt(paths: string[]): Promise<Map<string, string>> {
  const now = Date.now();
  const missing = [...new Set(paths)].filter((p) => !((artCache.get(p)?.until ?? 0) > now));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const { data } = await supabase.storage.from('media-art').createSignedUrls(chunk, ART_SECONDS);
    for (const d of data ?? []) {
      if (d.path && d.signedUrl) artCache.set(d.path, { url: d.signedUrl, until: now + (ART_SECONDS - 300) * 1000 });
    }
  }
  return new Map(paths.flatMap((p) => (artCache.has(p) ? [[p, artCache.get(p)!.url] as const] : [])));
}

export const artQuery = (householdId: string, paths: string[]) => {
  const sorted = [...new Set(paths)].sort();
  return queryOptions({
    queryKey: mediaKey(householdId, 'art', sorted.join('|')),
    queryFn: () => signArt(sorted),
    staleTime: (ART_SECONDS - 600) * 1000,
    enabled: sorted.length > 0,
  });
};

// ── Playlists ─────────────────────────────────────────────────────────────────
export interface Playlist {
  id: string;
  household_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
  trackIds: string[];
}

export const playlistsQuery = (householdId: string) =>
  queryOptions({
    queryKey: mediaKey(householdId, 'playlists'),
    queryFn: async (): Promise<Playlist[]> => {
      const { data, error } = await supabase
        .from('media_playlist')
        .select('id, household_id, name, sort, created_at, updated_at, media_playlist_item(track_id, position)')
        .eq('household_id', householdId)
        .order('sort')
        .order('name');
      if (error) throw error;
      type Row = Omit<Playlist, 'trackIds'> & { media_playlist_item: { track_id: string; position: number }[] };
      return (data as unknown as Row[]).map(({ media_playlist_item: items, ...p }) => ({
        ...p,
        trackIds: [...items].sort((a, b) => a.position - b.position).map((i) => i.track_id),
      }));
    },
    staleTime: 30_000,
  });

export async function createPlaylist(householdId: string, name: string, trackIds: string[] = []): Promise<string> {
  const { data, error } = await supabase
    .from('media_playlist')
    .insert({ household_id: householdId, name: name.trim() })
    .select('id')
    .single();
  if (error) throw error;
  if (trackIds.length) await setPlaylistTracks(data.id, trackIds);
  return data.id;
}

export async function renamePlaylist(id: string, name: string) {
  const { error } = await supabase.from('media_playlist').update({ name: name.trim() }).eq('id', id);
  if (error) throw error;
}

export async function deletePlaylist(id: string) {
  const { error } = await supabase.from('media_playlist').delete().eq('id', id);
  if (error) throw error;
}

export async function setPlaylistTracks(id: string, trackIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('rpc_media_playlist_set', { p_playlist: id, p_track_ids: trackIds });
  if (error) throw error;
  return data as number;
}

// ── Player + commands ─────────────────────────────────────────────────────────
export interface Player {
  device_id: string;
  household_id: string;
  state: PlayerState;
  track_id: string | null;
  elapsed_s: number;
  duration_s: number | null;
  at: string;
  volume: number;
  sleep_until: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
  queue: string[];
  queue_index: number | null;
  updated_at: string;
}

export const playersQuery = (householdId: string) =>
  queryOptions({
    queryKey: mediaKey(householdId, 'player'),
    queryFn: async (): Promise<Player[]> => {
      const { data, error } = await supabase.from('media_player').select('*').eq('household_id', householdId);
      if (error) throw error;
      return (data as unknown as Player[]).map(normalisePlayer);
    },
    staleTime: 10_000,
  });

export function normalisePlayer(p: Player): Player {
  return { ...p, elapsed_s: Number(p.elapsed_s) || 0, duration_s: p.duration_s == null ? null : Number(p.duration_s) };
}

export async function sendMediaCommand(deviceId: string, command: MediaCommandName, args: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_media_command', { p_device: deviceId, p_command: command, p_args: args as Json });
  if (error) throw error;
  return data as string;
}

export type CommandOutcome = 'done' | 'failed' | 'expired' | 'timeout';

/** Polls a command until the speaker answers or `timeoutMs` passes ("the speaker didn't answer"). */
export async function waitForMediaCommand(id: string, timeoutMs = 5000, everyMs = 350): Promise<CommandOutcome> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    const { data } = await supabase.from('media_command').select('status').eq('id', id).maybeSingle();
    const s = (data as { status: string } | null)?.status;
    if (s === 'done' || s === 'failed' || s === 'expired') return s;
  }
  return 'timeout';
}

/** What the screen should show right away, before the speaker confirms (rolled back on failure). */
export function optimistic(p: Player, command: MediaCommandName, args: Record<string, unknown>, now = Date.now()): Player {
  const at = new Date(now).toISOString();
  const elapsed = p.state === 'playing' ? p.elapsed_s + Math.max(0, (now - Date.parse(p.at)) / 1000) : p.elapsed_s;
  switch (command) {
    case 'pause':
      return { ...p, state: 'paused', elapsed_s: elapsed, at };
    case 'resume':
      return { ...p, state: 'playing', elapsed_s: elapsed, at };
    case 'stop':
      return { ...p, state: 'stopped', elapsed_s: 0, at };
    case 'seek':
      return { ...p, elapsed_s: Number(args.s) || 0, at };
    case 'volume':
      return { ...p, volume: Number(args.v) };
    case 'shuffle':
      return { ...p, shuffle: Boolean(args.on) };
    case 'repeat':
      return { ...p, repeat: (args.mode as RepeatMode) ?? 'off' };
    case 'sleep':
      return { ...p, sleep_until: Number(args.minutes) > 0 ? new Date(now + Number(args.minutes) * 60_000).toISOString() : null };
    case 'next':
    case 'prev': {
      if (p.queue_index == null) return p;
      const i = Math.max(0, Math.min(p.queue.length - 1, p.queue_index + (command === 'next' ? 1 : -1)));
      return { ...p, queue_index: i, track_id: p.queue[i] ?? p.track_id, elapsed_s: 0, at };
    }
    case 'play': {
      const ids = (args.track_ids as string[] | undefined) ?? [];
      const i = Number(args.index ?? 0);
      return ids.length ? { ...p, state: 'playing', queue: ids, queue_index: i, track_id: ids[i] ?? null, elapsed_s: 0, at } : p;
    }
    default:
      return p;
  }
}

export function emptyPlayer(deviceId: string, householdId: string): Player {
  return {
    device_id: deviceId,
    household_id: householdId,
    state: 'stopped',
    track_id: null,
    elapsed_s: 0,
    duration_s: null,
    at: new Date(0).toISOString(),
    volume: 50,
    sleep_until: null,
    shuffle: false,
    repeat: 'off',
    queue: [],
    queue_index: null,
    updated_at: new Date(0).toISOString(),
  };
}

// ── Schedules ─────────────────────────────────────────────────────────────────
export interface MediaSchedule {
  id: string;
  household_id: string;
  device_id: string;
  name: string;
  days: number;
  start_time: string;
  playlist_id: string | null;
  volume: number;
  stop_after_min: number | null;
  fade_s: number;
  shuffle: boolean;
  enabled: boolean;
}

export const schedulesQuery = (householdId: string) =>
  queryOptions({
    queryKey: mediaKey(householdId, 'schedules'),
    queryFn: async (): Promise<MediaSchedule[]> => {
      const { data, error } = await supabase
        .from('media_schedule')
        .select('id, household_id, device_id, name, days, start_time, playlist_id, volume, stop_after_min, fade_s, shuffle, enabled')
        .eq('household_id', householdId)
        .order('start_time');
      if (error) throw error;
      return data as unknown as MediaSchedule[];
    },
    staleTime: 60_000,
  });

export type ScheduleInput = Omit<MediaSchedule, 'id'>;

export async function saveSchedule(s: ScheduleInput & { id?: string }) {
  const { id, ...row } = s;
  const { error } = id
    ? await supabase.from('media_schedule').update(row).eq('id', id)
    : await supabase.from('media_schedule').insert(row);
  if (error) throw error;
}

export async function deleteSchedule(id: string) {
  const { error } = await supabase.from('media_schedule').delete().eq('id', id);
  if (error) throw error;
}

/** Bit 0 = Monday … bit 6 = Sunday. */
export const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const;

export type MediaErrorKey =
  | 'music.errors.inboxFull'
  | 'music.errors.slowDown'
  | 'music.errors.wrongCode'
  | 'music.errors.notAllowed'
  | 'music.errors.rejected'
  | 'music.errors.generic';

/** The i18n key for an error from these RPCs. */
export function mediaErrorKey(e: unknown): MediaErrorKey {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDMQF') return 'music.errors.inboxFull';
  if (code === 'GDRTE') return 'music.errors.slowDown';
  if (code === 'GDPCN') return 'music.errors.wrongCode';
  if (code === '42501') return 'music.errors.notAllowed';
  if (code === '23514') return 'music.errors.rejected';
  return 'music.errors.generic';
}
