// Home Assistant bridge protocol v1 (Phase 8; docs/home-assistant/protocol.md). The bridge on the
// Gedara Pi (devices/home-bridge) talks only to the home-agent Edge Function:
//   pair_start  { key_hash, hint, agent }            → { status: 'waiting', code (8 digits), expires_at } | { status: 'paired' }
//   pair_poll   header X-Gedara-Device: <its key>   → { status: 'waiting' | 'paired' | 'expired', device_id?, name?, household? }
//   sync        header X-Gedara-Device: <its key>   → SyncReply (wait: true holds the request up to 25 s
//                                                     until a command arrives)
// Shared by the function (Deno maps `zod` in its deno.json), the web app (`@home/protocol`) and the
// simulator (devices/home-bridge/tools/sim.ts). Device JSON is never trusted (CLAUDE.md rule 6):
// every field is bounded here and checked again in SQL. The Home Assistant token never appears in
// this protocol: it stays on the Pi.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** The bridge's own key: 43 characters of base64url, made on the Pi, never stored anywhere else. */
export const DeviceKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const text = (max: number) => z.string().max(max);

/** What Gedara shows from Home Assistant: doors and windows (binary_sensors), lights, switches, the AC. */
export const KINDS = ['door', 'window', 'light', 'switch', 'climate'] as const;
export type HomeKind = (typeof KINDS)[number];
export const DOMAINS = ['binary_sensor', 'light', 'switch', 'climate'] as const;
export type HomeDomain = (typeof DOMAINS)[number];
/** The only commands there are; the bridge maps them to switch/light/climate services and nothing else. */
export const ACTIONS = ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode'] as const;
export type HomeAction = (typeof ACTIONS)[number];
export const HA_STATES = ['connected', 'connecting', 'auth_failed', 'unreachable'] as const;
export type HaState = (typeof HA_STATES)[number];

export const EntityId = z.string().regex(/^[a-z_]{1,30}\.[a-z0-9_]{1,120}$/);

export const PairStart = z.object({
  action: z.literal('pair_start'),
  key_hash: sha256,
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  agent: text(40).optional(),
});

export const CatalogItem = z
  .object({
    entity_id: EntityId,
    domain: z.enum(DOMAINS),
    kind: z.enum(KINDS),
    name: z.string().min(1).max(100),
    area: text(60).nullable().optional(),
    device_class: text(30).nullable().optional(),
  })
  .refine((e) => e.entity_id.startsWith(`${e.domain}.`), 'entity_id must be in its domain')
  .refine((e) => (e.domain === 'binary_sensor' ? e.kind === 'door' || e.kind === 'window' : e.kind === e.domain), 'kind must match the domain');
export type CatalogItem = z.infer<typeof CatalogItem>;

const num = z.number().finite().min(-50).max(100);
export const ClimateAttrs = z
  .object({
    current_temperature: num.nullable(),
    temperature: num.nullable(),
    min_temp: num,
    max_temp: num,
    target_temp_step: num,
    hvac_modes: z.array(text(20)).max(10),
  })
  .partial();
export type ClimateAttrs = z.infer<typeof ClimateAttrs>;

export const StateReport = z.object({
  entity_id: EntityId,
  state: text(30),
  attrs: ClimateAttrs.optional(),
  changed_at: z.iso.datetime({ offset: true }).optional(),
});
export type StateReport = z.infer<typeof StateReport>;

export const BridgeStatus = z.object({
  ha: z.enum(HA_STATES),
  ha_version: text(20).optional(),
  entities: z.number().int().min(0).max(10_000).optional(),
});

export const SyncRequest = z.object({
  action: z.literal('sync'),
  v: z.literal(PROTOCOL_VERSION),
  agent: text(32),
  up: z.number().int().min(0).max(4_294_967_295),
  /** Hold the reply (≤ 25 s) until there is a command. */
  wait: z.boolean().optional(),
  status: BridgeStatus.optional(),
  catalog: z.array(CatalogItem).max(400).optional(),
  /** The catalog is everything HA has: entities not in it are removed from Gedara. */
  catalog_full: z.boolean().optional(),
  states: z.array(StateReport).max(400).optional(),
  done: z.array(z.object({ id: uuid, ok: z.boolean(), error: text(200).optional() })).max(50).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export interface HomeCommand {
  id: string;
  entity_id: string;
  action: HomeAction;
  args: { temperature?: number; hvac_mode?: string };
}

export interface SyncReply {
  ok: true;
  fn_version: string;
  device_id: string;
  name: string;
  commands: HomeCommand[];
  /** Gedara has no entities from this bridge yet: send the whole catalog. */
  need_catalog: boolean;
}
