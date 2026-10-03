// Kitchen-scale protocol v1 (Phase 6b; docs/kitchen-scale/protocol.md). One request per sync: the
// scale sends its status, any stable weighings from its outbox (with sequence numbers), a live state
// and the commands it finished; the reply acks the readings and carries results, commands, config and
// the containers list. Shared by the scale-ingest Edge Function (Deno maps `zod` in its deno.json),
// the web app (`@scale/protocol`) and the simulator (devices/kitchen-scale/tools/sim.mts). Device JSON
// is never trusted (CLAUDE.md rule 6): every field is bounded here and checked again in SQL.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const u32 = z.number().int().min(0).max(4294967295);
/** Milliseconds (uptime or epoch). */
const ms = z.number().int().min(0).max(9_000_000_000_000);
const grams = z.number().finite().min(-10_000).max(20_000);

/** NTAG / MIFARE UID: 4, 7 or 10 bytes as upper-case hex. */
export const TagUid = z.string().regex(/^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/);
/** The container's code from the tag's NDEF URL record (…/s/HL:LOC:XXXXXX). */
export const PlaceCode = z.string().regex(/^HL:LOC:[0-9A-HJKMNP-TV-Z]{6}$/);

export const LIVE_STATES = ['empty', 'settling', 'stable', 'overload', 'no_tag', 'setup', 'error'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const WeighEvent = z.object({
  seq: u32,
  b: u32, // boot counter when it was weighed
  t: ms, // uptime then
  at: ms.optional(), // epoch ms, only when the clock was set (SNTP)
  type: z.literal('weigh'),
  uid: TagUid.optional(),
  ndef: PlaceCode.optional(),
  gross_g: grams,
  stable_ms: z.number().int().min(0).max(60_000).optional(),
  flags: z.number().int().min(0).max(65_535).optional(),
});
export type WeighEvent = z.infer<typeof WeighEvent>;

export const DeviceStatus = z.object({
  rssi: z.number().int().min(-127).max(0).optional(),
  heap: z.number().int().min(0).max(100_000_000).optional(),
  heap_min: z.number().int().min(0).max(100_000_000).optional(),
  queue: z.number().int().min(0).max(1_000_000).optional(),
  reset: z.string().regex(/^[a-z_]{1,24}$/).optional(),
  cal: z
    .object({
      factor: z.number().finite().optional(),
      zero: z.number().int().optional(),
      azt: z.number().finite().optional(),
    })
    .optional(),
  time_ok: z.boolean().optional(),
  err: z.string().max(80).nullable().optional(),
  ip: z.string().regex(/^[0-9a-fA-F.:]{3,45}$/).optional(),
  fs_free: z.number().int().min(0).max(100_000_000).optional(),
  ota: z.string().max(40).optional(), // "pending_verify" / "rolled_back:0.2.0" …
  latency_ms: z.number().int().min(0).max(600_000).optional(), // last stable → reply
});
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const SyncRequest = z.object({
  v: z.literal(PROTOCOL_VERSION),
  fw: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  epoch: u32,
  boot: u32,
  up: ms,
  status: DeviceStatus.optional(),
  events: z.array(WeighEvent).max(20).default([]),
  live: z
    .object({ state: z.enum(LIVE_STATES), uid: TagUid.optional(), gross_g: grams.optional() })
    .optional(),
  done: z
    .array(
      z.object({
        id: z.uuid(),
        ok: z.boolean(),
        result: z.record(z.string().max(24), z.union([z.number().finite(), z.string().max(80), z.boolean(), z.null()])).optional(),
      }),
    )
    .max(10)
    .default([]),
  containers_v: z.string().regex(/^[0-9a-f]{1,8}$/).optional(),
});
export type SyncRequest = z.input<typeof SyncRequest>;

// ── Reply ─────────────────────────────────────────────────────────────────────
export const READING_STATUSES = [
  'consumed',
  'no_change',
  'refilled',
  'needs_decision',
  'decided',
  'below_tare',
  'superseded',
  'unknown_tag',
  'no_tag',
  'no_product',
  'no_tare',
  'tare_set',
  'error',
] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

const num = z.number().finite();

export const ReadingResult = z.looseObject({
  seq: u32.optional(),
  status: z.enum([...READING_STATUSES, 'pruned']),
  name: z.string().nullish(),
  container: z.string().nullish(),
  uid: z.string().nullish(),
  gross_g: num.nullish(),
  tare_g: num.nullish(),
  net_g: num.nullish(),
  delta_g: num.nullish(),
  moved_g: num.nullish(),
  pending_g: num.nullish(),
  left_g: num.nullish(),
  replayed: z.boolean().optional(),
  linked: z.boolean().optional(),
});
export type ReadingResult = z.infer<typeof ReadingResult>;

export const DEVICE_COMMANDS = ['tare', 'calibrate', 'beep', 'identify', 'reboot', 'ota'] as const;
export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export const ReplyCommand = z.object({
  id: z.uuid(),
  command: z.enum(DEVICE_COMMANDS),
  args: z.looseObject({}),
});

export const SyncReply = z.object({
  ok: z.literal(true),
  fn_version: z.string(),
  acked: z.array(u32),
  results: z.array(ReadingResult),
  commands: z.array(ReplyCommand),
  config: z.looseObject({
    v: z.number().int(),
    volume: z.number().int().min(0).max(100),
    quiet_from: z.string(),
    quiet_to: z.string(),
    voice: z.boolean(),
    threshold_g: num,
    tz_offset_min: z.number().int(),
  }),
  containers: z.object({
    v: z.string(),
    items: z
      .array(z.object({ uid: z.string(), name: z.string(), tare_g: num.nullable(), holds: z.boolean() }))
      .optional(),
  }),
  poll_ms: z.number().int().positive(),
  server_time: z.number().int().positive(),
});
export type SyncReply = z.infer<typeof SyncReply>;

/** "04:a1:b2 …" / "04a1b2…" → "04A1B2…", or null when it isn't a tag UID. Same rule as private.nfc_uid. */
export function normaliseUid(raw: string | null | undefined): string | null {
  const u = (raw ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return TagUid.safeParse(u).success ? u : null;
}
