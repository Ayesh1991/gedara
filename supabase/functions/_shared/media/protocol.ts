// Music-speaker protocol v1 (Phase 7h; docs/media-player/protocol.md). The Raspberry Pi's
// gedara-media-agent talks only to the media-agent Edge Function:
//   pair_start  { key_hash, hint, agent }            → { status: 'waiting', code (8 digits), expires_at } | { status: 'paired' }
//   pair_poll   header X-Gedara-Device: <its key>   → { status: 'waiting' | 'paired' | 'expired', device_id?, name? }
//   sync        header X-Gedara-Device: <its key>   → SyncReply (wait: true holds the request up to 25 s
//                                                     until a command arrives)
//   art_upload  header X-Gedara-Device              → { path, url } signed upload for a folder song's cover
// Shared by the function (Deno maps `zod` in its deno.json), the web app (`@media/protocol`) and the
// simulator (devices/media-player/tools/sim.ts). Device JSON is never trusted (CLAUDE.md rule 6):
// every field is bounded here and checked again in SQL.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** The speaker's own key: 43 characters of base64url, made on the Pi, never stored anywhere else. */
export const DeviceKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);
// Any 8-4-4-4-12 hex id (Zod 4's .uuid() also demands RFC version bits, which test fixtures don't have).
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const text = (max: number) => z.string().max(max);
const seconds = z.number().finite().min(0).max(86_400);
const ms = z.number().int().min(0).max(9_000_000_000_000);

export const MEDIA_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/ogg', 'audio/wav'] as const;
export type MediaMime = (typeof MEDIA_MIMES)[number];
export const PLAYER_STATES = ['stopped', 'playing', 'paused'] as const;
export type PlayerState = (typeof PLAYER_STATES)[number];
export const REPEAT_MODES = ['off', 'all', 'one'] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

/** A path on the speaker, under its music folder ("inbox/<id>.mp3", "pc/Album/01 Song.flac"). */
const DeviceFile = z
  .string()
  .min(1)
  .max(500)
  .refine((f) => !f.startsWith('/') && !f.split('/').includes('..'), 'relative path inside the music folder');

export const PairStart = z.object({
  action: z.literal('pair_start'),
  key_hash: sha256,
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  agent: text(40).optional(),
});

export const PlayerReport = z.object({
  state: z.enum(PLAYER_STATES),
  track_id: uuid.nullable(),
  elapsed_s: seconds,
  duration_s: seconds.nullable(),
  volume: z.number().int().min(0).max(100),
  sleep_until_ms: ms.nullable(),
  shuffle: z.boolean(),
  repeat: z.enum(REPEAT_MODES),
  queue: z.array(uuid).max(500),
  queue_index: z.number().int().min(0).max(499).nullable(),
});
export type PlayerReport = z.infer<typeof PlayerReport>;

export const SpeakerStatus = z.object({
  output: z.enum(['usb', 'jack', 'none']).optional(),
  disk_free_mb: z.number().int().min(0).max(10_000_000).optional(),
  disk_total_mb: z.number().int().min(0).max(10_000_000).optional(),
  temp_c: z.number().finite().min(-40).max(150).optional(),
  mpd: z.boolean().optional(),
  files: z.number().int().min(0).max(1_000_000).optional(),
  error: text(200).nullable().optional(),
});

export const FolderSong = z.object({
  sha256,
  file: DeviceFile,
  size_bytes: z.number().int().min(1).max(2_147_483_647),
  mime: z.enum(MEDIA_MIMES),
  title: z.string().min(1).max(200),
  artist: text(200).optional(),
  album: text(200).optional(),
  track_no: z.number().int().min(0).max(999).optional(),
  duration_s: seconds.optional(),
});
export type FolderSong = z.infer<typeof FolderSong>;

export const SyncRequest = z.object({
  action: z.literal('sync'),
  v: z.literal(PROTOCOL_VERSION),
  agent: text(32),
  up: z.number().int().min(0).max(4_294_967_295),
  /** Hold the reply (≤ 25 s) until there is something to do. */
  wait: z.boolean().optional(),
  status: SpeakerStatus.optional(),
  player: PlayerReport.optional(),
  done: z.array(z.object({ id: uuid, ok: z.boolean(), error: text(200).optional() })).max(50).optional(),
  downloaded: z.array(z.object({ id: uuid, ok: z.boolean(), file: DeviceFile.optional(), error: text(200).optional() })).max(20).optional(),
  deleted: z.array(uuid).max(100).optional(),
  pc_added: z.array(FolderSong).max(20).optional(),
  pc_removed: z.array(DeviceFile).max(100).optional(),
  played: z.array(z.object({ id: uuid, at_ms: ms })).max(20).optional(),
  art: z.array(z.object({ sha256, art_path: z.string().max(200) })).max(20).optional(),
  known: z.object({ settings_v: z.string().max(20).nullable(), schedules_v: z.string().max(64).nullable() }).partial().optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/** A cover for a folder song, by the song's sha256 (the Pi doesn't know Gedara's ids). */
export const ArtUpload = z.object({ action: z.literal('art_upload'), sha256 });

/** A song the speaker should play, as the file on its card. */
export const QueueSong = z.object({ id: uuid, file: z.string() });
export type QueueSong = z.infer<typeof QueueSong>;

export const COMMANDS = ['play', 'pause', 'resume', 'stop', 'next', 'prev', 'seek', 'volume', 'sleep', 'shuffle', 'repeat',
  'queue_add', 'queue_move', 'queue_remove', 'test_tone', 'rescan'] as const;
export type MediaCommandName = (typeof COMMANDS)[number];

export interface MediaCommand {
  id: string;
  command: MediaCommandName;
  args: Record<string, unknown>;
}

export interface Download {
  id: string;
  path: string;
  sha256: string;
  size_bytes: number;
  mime: MediaMime;
  /** Signed by the function for 15 minutes. */
  url?: string;
}

export interface Schedule {
  id: string;
  name: string;
  /** bit 0 = Monday … bit 6 = Sunday */
  days: number;
  /** "HH:MM", Asia/Colombo */
  start: string;
  volume: number;
  stop_after_min: number | null;
  fade_s: number;
  shuffle: boolean;
  /** null = the whole library */
  tracks: QueueSong[] | null;
}

export interface SpeakerSettings {
  volume_max?: number;
  fade_s?: number;
  normalise?: boolean;
}

export interface SyncReply {
  ok: true;
  fn_version: string;
  device_id: string;
  name: string;
  commands: MediaCommand[];
  downloads: Download[];
  deletions: { id: string; file: string | null }[];
  trash?: string[];
  settings_v: number;
  settings?: SpeakerSettings;
  schedules_v: string;
  schedules?: Schedule[];
  tz: string;
}

/** Song file types by their first bytes (CLAUDE.md rule 6: never trust the file extension). */
export function sniffAudio(head: Uint8Array): MediaMime | null {
  const at = (s: string, off = 0) => [...s].every((c, i) => head[off + i] === c.charCodeAt(0));
  if (at('ID3')) return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) {
    // MPEG audio frame sync (layer bits not "reserved"); ADTS AAC (layer 00) is not accepted as MP3.
    return 'audio/mpeg';
  }
  if (at('fLaC')) return 'audio/flac';
  if (at('OggS')) return 'audio/ogg';
  if (at('RIFF') && at('WAVE', 8)) return 'audio/wav';
  if (at('ftyp', 4) && (at('M4A ', 8) || at('M4B ', 8) || at('mp42', 8) || at('isom', 8) || at('dash', 8))) return 'audio/mp4';
  return null;
}

export const EXTENSIONS: Record<MediaMime, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};
