// Home Assistant in Gedara (Phase 8) — the pure part (no Supabase import, so tests can load it):
// what is open / on / available, rooms and the summary line, optimistic tiles, AC temperature steps,
// error words. lib/home/queries.ts re-exports all of it.
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
  domain: 'binary_sensor' | 'light' | 'switch' | 'climate';
  kind: HomeKind;
  ha_name: string;
  label: string | null;
  area: string | null;
  device_class: string | null;
  state: string | null;
  attrs: ClimateAttrs;
  shown: boolean;
  controllable: boolean;
  changed_at: string | null;
  updated_at: string;
}

/** Online if heard from in the last 90 s (it long-polls every 25 s). */
export function bridgeOnline(b: { last_seen_at: string | null } | null | undefined, now = Date.now()): boolean {
  return !!b?.last_seen_at && now - Date.parse(b.last_seen_at) < 90_000;
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
}

const KIND_ORDER: Record<HomeKind, number> = { climate: 0, switch: 1, light: 2, door: 3, window: 4 };

/** The shown entities by room (Home Assistant's areas), rooms A–Z with "Other" last. */
export function roomsOf(entities: HomeEntity[], collator = new Intl.Collator()): Room[] {
  const map = new Map<string | null, Room>();
  const sorted = [...entities]
    .filter((e) => e.shown)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(displayName(a), displayName(b)));
  for (const e of sorted) {
    const r = map.get(e.area) ?? { name: e.area, openings: [], lights: [], switches: [], climates: [] };
    if (e.kind === 'door' || e.kind === 'window') r.openings.push(e);
    else if (e.kind === 'light') r.lights.push(e);
    else if (e.kind === 'switch') r.switches.push(e);
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
