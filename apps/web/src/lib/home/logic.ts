// Home Assistant in Gedara (Phase 8) — the pure part (no Supabase import, so tests can load it):
// what is open / on / available, rooms and the summary line, optimistic tiles, AC temperature steps,
// error words, the house log's rows (Phase 8b). lib/home/queries.ts re-exports all of it.
import type { HomeAction, HomeKind } from '@home/protocol';

export interface ClimateAttrs {
  current_temperature?: number | null;
  temperature?: number | null;
  min_temp?: number;
  max_temp?: number;
  target_temp_step?: number;
  hvac_modes?: string[];
}

export interface HomeEntity {
  id: string;
  household_id: string;
  device_id: string;
  entity_id: string;
  domain: 'binary_sensor' | 'light' | 'switch' | 'climate' | 'sensor';
  kind: HomeKind;
  ha_name: string;
  label: string | null;
  area: string | null;
  device_class: string | null;
  state: string | null;
  attrs: ClimateAttrs;
  shown: boolean;
  controllable: boolean;
  /** Phase 8b: where it comes from ("esphome" …), a sensor's unit, kept in the log, sends alerts. */
  platform: string | null;
  unit: string | null;
  logged: boolean;
  alert: boolean;
  changed_at: string | null;
  updated_at: string;
}

const ONLINE_MS = 150_000;
/** Heard from in the last 150 s: it long-polls every 55 s (25 s before bridge 0.2.1), plus slack. */
export function bridgeOnline(b: { last_seen_at: string | null } | null | undefined, now = Date.now()): boolean {
  return !!b?.last_seen_at && now - Date.parse(b.last_seen_at) < ONLINE_MS;
}

export function displayName(e: Pick<HomeEntity, 'label' | 'ha_name'>): string {
  return e.label ?? e.ha_name;
}

/** Home Assistant knows it and it's reachable (not "unavailable" / "unknown"). */
export function isAvailable(e: Pick<HomeEntity, 'state'>): boolean {
  return !!e.state && e.state !== 'unavailable' && e.state !== 'unknown';
}

/** Doors and windows: "on" means open in Home Assistant. */
export const isOpen = (e: Pick<HomeEntity, 'kind' | 'state'>) => (e.kind === 'door' || e.kind === 'window') && e.state === 'on';
/** Lights and switches are on; an AC is on in any mode but "off". */
export const isOn = (e: Pick<HomeEntity, 'kind' | 'state'>) =>
  e.kind === 'climate' ? isAvailable(e) && e.state !== 'off' : (e.kind === 'light' || e.kind === 'switch') && e.state === 'on';

export interface Room {
  name: string | null; // null = no room in Home Assistant ("Other")
  openings: HomeEntity[];
  lights: HomeEntity[];
  switches: HomeEntity[];
  climates: HomeEntity[];
  /** Phase 8b: people detected, sensor values, other binary sensors (dark detection …). */
  presence: HomeEntity[];
  sensors: HomeEntity[];
  binaries: HomeEntity[];
}

const KIND_ORDER: Record<HomeKind, number> = { climate: 0, presence: 1, sensor: 2, switch: 3, light: 4, binary: 5, door: 6, window: 7 };
export const kindOrder = (k: HomeKind) => KIND_ORDER[k];

/** Someone detected (a presence sensor that is on). */
export const isDetected = (e: Pick<HomeEntity, 'kind' | 'state'>) => e.kind === 'presence' && e.state === 'on';

/** A sensor's value for people: "28.9 °C", "45 %"; null when it isn't a number. */
export function sensorValue(state: string | null, unit: string | null, locale?: string): string | null {
  if (state === null || !/^-?\d+(\.\d+)?$/.test(state)) return null;
  const n = Number(state);
  const s = new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 }).format(n);
  return unit ? `${s} ${unit}` : s;
}

/** The shown entities by room (Home Assistant's areas), rooms A–Z with "Other" last. */
export function roomsOf(entities: HomeEntity[], collator = new Intl.Collator()): Room[] {
  const map = new Map<string | null, Room>();
  const sorted = [...entities]
    .filter((e) => e.shown)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(displayName(a), displayName(b)));
  for (const e of sorted) {
    const r = map.get(e.area) ?? { name: e.area, openings: [], lights: [], switches: [], climates: [], presence: [], sensors: [], binaries: [] };
    if (e.kind === 'door' || e.kind === 'window') r.openings.push(e);
    else if (e.kind === 'light') r.lights.push(e);
    else if (e.kind === 'switch') r.switches.push(e);
    else if (e.kind === 'presence') r.presence.push(e);
    else if (e.kind === 'sensor') r.sensors.push(e);
    else if (e.kind === 'binary') r.binaries.push(e);
    else r.climates.push(e);
    map.set(e.area, r);
  }
  return [...map.values()].sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : collator.compare(a.name, b.name)));
}

export interface HouseSummary {
  open: HomeEntity[];
  lights: number;
  lightsOn: number;
  ac: HomeEntity | null;
  unavailable: number;
  /** Rooms where someone is detected now (Phase 8b). */
  peopleIn: string[];
}

/** The line at the top of the House page (and the Home card): what's open, lights on, the AC. */
export function summaryOf(entities: HomeEntity[]): HouseSummary {
  const shown = entities.filter((e) => e.shown);
  const acs = shown.filter((e) => e.kind === 'climate');
  return {
    open: shown.filter(isOpen),
    lights: shown.filter((e) => e.kind === 'light').length,
    lightsOn: shown.filter((e) => e.kind === 'light' && e.state === 'on').length,
    ac: acs.find(isOn) ?? acs[0] ?? null,
    unavailable: shown.filter((e) => !isAvailable(e)).length,
    peopleIn: [...new Set(shown.filter(isDetected).map((e) => e.area ?? displayName(e)))],
  };
}

/** What a tile shows at once, before Home Assistant confirms (rolled back if it doesn't). */
export function optimistic(e: HomeEntity, action: HomeAction, args: Record<string, unknown>): HomeEntity {
  switch (action) {
    case 'turn_on':
      return { ...e, state: e.kind === 'climate' ? (e.attrs.hvac_modes?.find((m) => m !== 'off') ?? 'cool') : 'on' };
    case 'turn_off':
      return { ...e, state: 'off' };
    case 'set_temperature':
      return { ...e, attrs: { ...e.attrs, temperature: Number(args.temperature) } };
    case 'set_hvac_mode':
      return { ...e, state: String(args.hvac_mode) };
  }
}

/** The AC's temperature steps: its own min / max (16–32 if HA didn't say), half degrees. */
export function nextTemperature(e: HomeEntity, dir: 1 | -1): number | null {
  const step = Math.max(0.5, e.attrs.target_temp_step ?? 0.5);
  const lo = e.attrs.min_temp ?? 16;
  const hi = e.attrs.max_temp ?? 32;
  const now = e.attrs.temperature ?? Math.round((lo + hi) / 2);
  const next = Math.round((now + dir * step) * 2) / 2;
  return next < lo || next > hi ? null : next;
}

// ── The house log (Phase 8b) ──────────────────────────────────────────────────
export interface HomeEvent {
  id: number;
  entity: string | null;
  entity_id: string;
  name: string;
  area: string | null;
  kind: HomeKind;
  state: string;
  value: number | null;
  unit: string | null;
  at: string;
}

/** One line of the log: an opening / a person detected with when it ended (if it did), a sensor
 *  value, or any other change. */
export type LogRow =
  | { type: 'span'; key: string; kind: HomeKind; name: string; area: string | null; start: string; end: string | null; seconds: number | null }
  | { type: 'value'; key: string; kind: HomeKind; name: string; area: string | null; at: string; value: number | null; state: string; unit: string | null }
  | { type: 'change'; key: string; kind: HomeKind; name: string; area: string | null; at: string; state: string };

const SPAN_KINDS: ReadonlySet<HomeKind> = new Set(['door', 'window', 'presence', 'binary']);

/** Events (any order) → log rows, newest first. Doors, windows and presence become spans
 *  ("opened 21:54:33 → closed 21:55:10, 37 s"); a close with no open in view stands alone. */
export function logRows(events: HomeEvent[]): LogRow[] {
  const asc = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  const open = new Map<string, LogRow & { type: 'span' }>();
  const rows: LogRow[] = [];
  for (const e of asc) {
    if (e.kind === 'sensor') {
      rows.push({ type: 'value', key: `v${e.id}`, kind: e.kind, name: e.name, area: e.area, at: e.at, value: e.value === null ? null : Number(e.value), state: e.state, unit: e.unit });
    } else if (SPAN_KINDS.has(e.kind)) {
      const cur = open.get(e.entity_id);
      if (e.state === 'on') {
        if (!cur) {
          const row = { type: 'span' as const, key: `s${e.id}`, kind: e.kind, name: e.name, area: e.area, start: e.at, end: null, seconds: null };
          open.set(e.entity_id, row);
          rows.push(row);
        }
      } else if (cur) {
        cur.end = e.at;
        cur.seconds = Math.max(0, Math.round((Date.parse(e.at) - Date.parse(cur.start)) / 1000));
        open.delete(e.entity_id);
      } else {
        rows.push({ type: 'change', key: `c${e.id}`, kind: e.kind, name: e.name, area: e.area, at: e.at, state: e.state });
      }
    } else {
      rows.push({ type: 'change', key: `c${e.id}`, kind: e.kind, name: e.name, area: e.area, at: e.at, state: e.state });
    }
  }
  const at = (r: LogRow) => (r.type === 'span' ? r.start : r.at);
  return rows.sort((a, b) => at(b).localeCompare(at(a)));
}

/** "37 s", "4 min", "2 h 5 min". */
export function shortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export type HomeErrorKey =
  | 'house.errors.slowDown'
  | 'house.errors.wrongCode'
  | 'house.errors.notAllowed'
  | 'house.errors.rejected'
  | 'house.errors.generic';

/** The i18n key for an error from these RPCs. */
export function homeErrorKey(e: unknown): HomeErrorKey {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDRTE') return 'house.errors.slowDown';
  if (code === 'GDPCN') return 'house.errors.wrongCode';
  if (code === '42501') return 'house.errors.notAllowed';
  if (code === '23514') return 'house.errors.rejected';
  return 'house.errors.generic';
}

/** Minutes the time zone is ahead of UTC at that moment (Asia/Colombo: 330). */
export function tzOffsetMinutes(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at))
    .reduce<Record<string, number>>((o, p) => (p.type === 'literal' ? o : { ...o, [p.type]: Number(p.value) }), {});
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** A local day (YYYY-MM-DD in the household's time zone) as a UTC range [from, to). */
export function dayRange(day: string, tz: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const start = Date.UTC(y, m - 1, d);
  const end = Date.UTC(y, m - 1, d + 1);
  return {
    from: new Date(start - tzOffsetMinutes(tz, start) * 60_000).toISOString(),
    to: new Date(end - tzOffsetMinutes(tz, end) * 60_000).toISOString(),
  };
}

/** The local day (YYYY-MM-DD) of an instant in the household's time zone. */
export function localDay(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
}
