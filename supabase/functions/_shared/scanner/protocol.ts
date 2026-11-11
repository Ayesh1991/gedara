// Bin-scanner protocol v1 (Phase 11; docs/bin-scanner/protocol.md). One request per scan (or per
// small batch after being offline) and a rare heartbeat: the scanner sends its status, the scans
// from its outbox (with sequence numbers) and the commands it finished; the reply acks the scans and
// carries what happened to each, commands, settings and the names list. Shared by the scanner-ingest
// Edge Function (Deno maps `zod` in its deno.json), the web app (`@scanner/protocol`) and the
// simulator (devices/bin-scanner/tools/sim.ts). Device JSON is never trusted (CLAUDE.md rule 6):
// every field is bounded here and checked again in SQL. A scanned code can contain anything, so it
// is at most 96 printable ASCII characters and is only ever compared and shown, never interpreted.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const u32 = z.number().int().min(0).max(4294967295);
/** Milliseconds (uptime or epoch). */
const ms = z.number().int().min(0).max(9_000_000_000_000);

/** The only things a scanner can ask for. */
export const MODES = ['use', 'add', 'open', 'waste', 'check'] as const;
export type ScanMode = (typeof MODES)[number];

export const SCAN_TEXT_MAX = 96;
/** What the scanner read: printable ASCII only. */
export const ScanText = z.string().regex(/^[\x20-\x7E]{1,96}$/);

/** The scanner's raw line → the text to send, or null when it isn't usable (empty, too long, or with
 *  anything outside printable ASCII). The firmware applies the same rule (lib/scantext). */
export function cleanScanText(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/[\r\n]+$/g, '').trim();
  return ScanText.safeParse(s).success ? s : null;
}

const eventBase = {
  seq: u32,
  b: u32, // boot counter when it was scanned
  t: ms, // uptime then
  at: ms.optional(), // epoch ms, only when the clock was set
};

export const ScanEvent = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('scan'),
    mode: z.enum(MODES),
    n: z.number().int().min(1).max(20).optional(), // how many (number keys)
    code: ScanText,
  }),
  // The * key: undo this scanner's own last scan.
  z.object({ ...eventBase, type: z.literal('undo') }),
]);
export type ScanEvent = z.infer<typeof ScanEvent>;

export const DeviceStatus = z.object({
  rssi: z.number().int().min(-127).max(0).optional(),
  heap: z.number().int().min(0).max(100_000_000).optional(),
  heap_min: z.number().int().min(0).max(100_000_000).optional(),
  queue: z.number().int().min(0).max(1_000_000).optional(),
  reset: z.string().regex(/^[a-z_]{1,24}$/).optional(),
  time_ok: z.boolean().optional(),
  err: z.string().max(80).nullable().optional(),
  ip: z.string().regex(/^[0-9a-fA-F.:]{3,45}$/).optional(),
  fs_free: z.number().int().min(0).max(100_000_000).optional(),
  ota: z.string().max(40).optional(), // "pending_verify" / "rolled_back:0.2.0" …
  latency_ms: z.number().int().min(0).max(600_000).optional(), // last scan → answer
  eye: z.string().regex(/^[a-z_]{1,16}$/).optional(), // how the scanner module is set: sense / always / key / missing
  names: z.number().int().min(0).max(10_000).optional(), // entries in its names list
});
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const SyncRequest = z.object({
  v: z.literal(PROTOCOL_VERSION),
  fw: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  epoch: u32,
  boot: u32,
  up: ms,
  status: DeviceStatus.optional(),
  events: z.array(ScanEvent).max(20).default([]),
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
  cat_v: z.string().regex(/^[0-9a-f]{1,8}$/).optional(),
  log: z
    .array(z.object({ t: ms, m: z.string().max(160) }))
    .max(30)
    .optional(),
});
export type SyncRequest = z.input<typeof SyncRequest>;

// ── Reply ─────────────────────────────────────────────────────────────────────
export const SCAN_STATUSES = [
  'used',
  'wasted',
  'opened',
  'added',
  'moved',
  'in_jar',
  'no_stock',
  'nothing_to_open',
  'checked',
  'not_pantry',
  'undo',
  'undo_none',
  'dismissed',
  'error',
  'unknown',
  'bill_guard',
  'held',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
/** Scans that wait for a person. */
export const WAITING_STATUSES: readonly ScanStatus[] = ['unknown', 'bill_guard', 'held'];
/** Scans whose Undo button makes sense. */
export const UNDOABLE_STATUSES: readonly ScanStatus[] = ['used', 'wasted', 'opened', 'added', 'moved', 'no_stock'];

const num = z.number().finite();

export const ScanResult = z.looseObject({
  seq: u32.optional(),
  status: z.enum([...SCAN_STATUSES, 'pruned']),
  code_kind: z.string().nullish(),
  product_id: z.string().nullish(),
  name: z.string().nullish(),
  dn: z.string().nullish(), // the name for the scanner's screen (Latin letters, ≤ 24)
  unit: z.string().nullish(),
  sized: z.boolean().nullish(),
  pack: num.nullish(),
  qty: num.nullish(),
  left_qty: num.nullish(),
  on_list: z.boolean().nullish(),
  jar: z.string().nullish(),
  due: z.string().nullish(),
  bill_qty: num.nullish(),
  bill_on: z.string().nullish(),
  reason: z.string().nullish(),
  replayed: z.boolean().optional(),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const DEVICE_COMMANDS = ['beep', 'identify', 'reboot', 'ota'] as const;
export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export const EYES = ['sense', 'always', 'key'] as const;
export type Eye = (typeof EYES)[number];
export const DEFAULT_KEYMAP = '123A456B789C*0#D';
/** How keenly the reader senses a pack in its sensing mode (max = as keen as the GM861S goes). */
export const SENSES = ['normal', 'high', 'max'] as const;
export type Sense = (typeof SENSES)[number];
export const DEFAULT_SENSE: Sense = 'high';

export const ScannerSettings = z.object({
  volume: z.number().int().min(0).max(100),
  quiet_from: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  quiet_to: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  eye: z.enum(EYES),
  eye_quiet: z.enum(['same', 'key']),
  mode_s: z.number().int().min(10).max(120),
  buzzer: z.enum(['passive', 'active']),
  bright: z.number().int().min(0).max(100),
  night_off: z.boolean(),
  keymap: z.string().regex(/^[0-9A-D*#]{16}$/),
  sense: z.enum(SENSES).optional(), // absent on scanners added before migration 110 = high
});
export type ScannerSettings = z.infer<typeof ScannerSettings>;

export const SyncReply = z.object({
  ok: z.literal(true),
  fn_version: z.string(),
  acked: z.array(u32),
  results: z.array(ScanResult),
  commands: z.array(z.object({ id: z.uuid(), command: z.enum(DEVICE_COMMANDS), args: z.looseObject({}) })),
  config: z.looseObject({ v: z.number().int(), tz_offset_min: z.number().int() }),
  cat: z.object({ v: z.string(), items: z.array(z.tuple([z.string(), z.string()])).optional() }),
  paused: z.boolean(),
  next_ms: z.number().int().positive(),
  server_time: z.number().int().positive(),
});
export type SyncReply = z.infer<typeof SyncReply>;
