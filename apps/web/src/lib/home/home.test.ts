import { describe, expect, it } from 'vitest';
import { CatalogItem, StateReport, SyncRequest } from '@home/protocol';
import {
  bridgeOnline,
  displayName,
  homeErrorKey,
  isAvailable,
  isOn,
  isOpen,
  nextTemperature,
  optimistic,
  roomsOf,
  summaryOf,
  type HomeEntity,
  dayRange,
  localDay,
  logRows,
  sensorValue,
  shortDuration,
  type HomeEvent,
} from './logic';

let n = 0;
function ent(p: Partial<HomeEntity> & Pick<HomeEntity, 'kind'>): HomeEntity {
  n++;
  const domain = p.kind === 'door' || p.kind === 'window' ? 'binary_sensor' : p.kind;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    household_id: 'h',
    device_id: 'd',
    entity_id: `${domain}.e${n}`,
    domain,
    ha_name: `E${n}`,
    label: null,
    area: null,
    device_class: null,
    state: 'off',
    attrs: {},
    shown: true,
    controllable: false,
    platform: null,
    unit: null,
    logged: false,
    alert: false,
    changed_at: null,
    updated_at: '2026-10-20T00:00:00Z',
    ...p,
  } as HomeEntity;
}

const AC = ent({ kind: 'climate', ha_name: 'AC', area: 'Bedroom', state: 'cool', controllable: true,
  attrs: { temperature: 24, min_temp: 16, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'cool', 'dry'] } });

describe('what is open, on, available', () => {
  it('doors and windows are open when HA says on', () => {
    expect(isOpen(ent({ kind: 'window', state: 'on' }))).toBe(true);
    expect(isOpen(ent({ kind: 'door', state: 'off' }))).toBe(false);
    expect(isOpen(ent({ kind: 'light', state: 'on' }))).toBe(false);
  });
  it('an AC is on in any mode but off', () => {
    expect(isOn(AC)).toBe(true);
    expect(isOn({ ...AC, state: 'off' })).toBe(false);
    expect(isOn({ ...AC, state: 'unavailable' })).toBe(false);
    expect(isOn(ent({ kind: 'switch', state: 'on' }))).toBe(true);
  });
  it('unavailable and unknown are not available', () => {
    expect(isAvailable({ state: 'unavailable' })).toBe(false);
    expect(isAvailable({ state: 'unknown' })).toBe(false);
    expect(isAvailable({ state: null })).toBe(false);
    expect(isAvailable({ state: 'off' })).toBe(true);
  });
  it('the owner’s short name wins', () => {
    expect(displayName({ label: 'Vaporizer', ha_name: 'Mosquito Vaporizer' })).toBe('Vaporizer');
    expect(displayName({ label: null, ha_name: 'Mosquito Vaporizer' })).toBe('Mosquito Vaporizer');
  });
});

describe('rooms and the summary', () => {
  const list = [
    AC,
    ent({ kind: 'window', ha_name: 'Bedroom Window 2', area: 'Bedroom', state: 'on' }),
    ent({ kind: 'window', ha_name: 'Bedroom Window 1', area: 'Bedroom', state: 'off' }),
    ent({ kind: 'switch', ha_name: 'Vaporizer', area: 'Bedroom', shown: false }),
    ent({ kind: 'door', ha_name: 'Front door', area: 'Living Room', state: 'on' }),
    ent({ kind: 'light', ha_name: 'Mist RGB', area: 'Bedroom', state: 'on' }),
    ent({ kind: 'light', ha_name: 'Porch', area: null, state: 'unavailable' }),
  ];
  it('groups what is shown by room, A–Z, with Other last', () => {
    const rooms = roomsOf(list);
    expect(rooms.map((r) => r.name)).toEqual(['Bedroom', 'Living Room', null]);
    expect(rooms[0]!.openings.map((e) => e.ha_name)).toEqual(['Bedroom Window 1', 'Bedroom Window 2']);
    expect(rooms[0]!.switches).toEqual([]); // hidden
    expect(rooms[0]!.climates).toHaveLength(1);
  });
  it('says what is open, how many lights are on, and the AC', () => {
    const s = summaryOf(list);
    expect(s.open.map((e) => e.ha_name)).toEqual(['Bedroom Window 2', 'Front door']);
    expect(s.lights).toBe(2);
    expect(s.lightsOn).toBe(1);
    expect(s.ac?.ha_name).toBe('AC');
    expect(s.unavailable).toBe(1);
  });
});

describe('controls', () => {
  it('shows the change at once', () => {
    expect(optimistic({ ...AC, state: 'off' }, 'turn_on', {}).state).toBe('cool');
    expect(optimistic(ent({ kind: 'switch' }), 'turn_on', {}).state).toBe('on');
    expect(optimistic(AC, 'set_temperature', { temperature: 23.5 }).attrs.temperature).toBe(23.5);
    expect(optimistic(AC, 'set_hvac_mode', { hvac_mode: 'dry' }).state).toBe('dry');
  });
  it('steps the AC in half degrees inside its own range', () => {
    expect(nextTemperature(AC, 1)).toBe(24.5);
    expect(nextTemperature(AC, -1)).toBe(23.5);
    expect(nextTemperature({ ...AC, attrs: { ...AC.attrs, temperature: 30 } }, 1)).toBeNull();
    expect(nextTemperature({ ...AC, attrs: { ...AC.attrs, temperature: 16 } }, -1)).toBeNull();
    expect(nextTemperature({ ...AC, attrs: { ...AC.attrs, target_temp_step: 1 } }, 1)).toBe(25);
  });
  it('maps errors to words', () => {
    expect(homeErrorKey({ code: 'GDRTE' })).toBe('house.errors.slowDown');
    expect(homeErrorKey({ code: '42501' })).toBe('house.errors.notAllowed');
    expect(homeErrorKey({ code: '23514' })).toBe('house.errors.rejected');
    expect(homeErrorKey(new Error('x'))).toBe('house.errors.generic');
  });
  it('the bridge is online for 90 s after it was heard from', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(bridgeOnline({ last_seen_at: '2026-10-20T09:59:00Z' }, now)).toBe(true);
    expect(bridgeOnline({ last_seen_at: '2026-10-20T09:58:00Z' }, now)).toBe(false);
    expect(bridgeOnline(null, now)).toBe(false);
  });
});

describe('protocol (what the bridge may send)', () => {
  it('a catalog item must be in its domain, with a matching kind', () => {
    expect(CatalogItem.safeParse({ entity_id: 'binary_sensor.w', domain: 'binary_sensor', kind: 'window', name: 'W' }).success).toBe(true);
    expect(CatalogItem.safeParse({ entity_id: 'switch.w', domain: 'binary_sensor', kind: 'window', name: 'W' }).success).toBe(false);
    expect(CatalogItem.safeParse({ entity_id: 'light.l', domain: 'light', kind: 'switch', name: 'L' }).success).toBe(false);
    expect(CatalogItem.safeParse({ entity_id: 'lock.front', domain: 'lock', kind: 'switch', name: 'Lock' }).success).toBe(false);
  });
  it('climate attributes are numbers in range, modes short strings', () => {
    expect(StateReport.safeParse({ entity_id: 'climate.ac', state: 'cool', attrs: { temperature: 24, hvac_modes: ['cool'] } }).success).toBe(true);
    expect(StateReport.safeParse({ entity_id: 'climate.ac', state: 'cool', attrs: { temperature: 400 } }).success).toBe(false);
    expect(StateReport.safeParse({ entity_id: 'climate.ac', state: 'cool', changed_at: 'yesterday' }).success).toBe(false);
  });
  it('a sync is bounded', () => {
    const states = Array.from({ length: 401 }, (_, i) => ({ entity_id: `light.l${i}`, state: 'on' }));
    expect(SyncRequest.safeParse({ action: 'sync', v: 1, agent: 'a', up: 1, states }).success).toBe(false);
    expect(SyncRequest.safeParse({ action: 'sync', v: 1, agent: 'a', up: 1, states: states.slice(0, 400) }).success).toBe(true);
  });
});

describe('Phase 8b: people, sensors and the house log', () => {
  it('rooms get people detected, sensors and other binary sensors', () => {
    const rooms = roomsOf([
      ent({ kind: 'presence', area: 'Living Room', state: 'on' }),
      ent({ kind: 'sensor', area: 'Bedroom', state: '28.9', unit: '°C' }),
      ent({ kind: 'binary', area: 'Living Room', state: 'off', device_class: 'light' }),
    ]);
    expect(rooms.find((r) => r.name === 'Living Room')!.presence).toHaveLength(1);
    expect(rooms.find((r) => r.name === 'Living Room')!.binaries).toHaveLength(1);
    expect(rooms.find((r) => r.name === 'Bedroom')!.sensors).toHaveLength(1);
    expect(summaryOf([ent({ kind: 'presence', area: 'Living Room', state: 'on' }), ent({ kind: 'presence', area: 'Bedroom', state: 'off' })]).peopleIn).toEqual(['Living Room']);
  });
  it('shows sensor values with their unit', () => {
    expect(sensorValue('28.94', '°C', 'en-LK')).toBe('28.9 °C');
    expect(sensorValue('45', '%', 'en-LK')).toBe('45 %');
    expect(sensorValue('1234.5', 'lx', 'en-LK')).toBe('1,235 lx');
    expect(sensorValue('unavailable', '°C')).toBeNull();
  });
  it('pairs openings with their closing, newest first', () => {
    const ev = (id: number, entity_id: string, kind: HomeEvent['kind'], state: string, at: string, value: number | null = null): HomeEvent =>
      ({ id, entity: null, entity_id, name: entity_id, area: null, kind, state, value, unit: value === null ? null : '°C', at });
    const rows = logRows([
      ev(1, 'door', 'door', 'on', '2026-11-02T16:24:33Z'),
      ev(3, 'door', 'door', 'off', '2026-11-02T16:25:10Z'),
      ev(2, 'presence', 'presence', 'on', '2026-11-02T16:24:40Z'),
      ev(4, 'temp', 'sensor', '28.9', '2026-11-02T16:26:00Z', 28.9),
      ev(5, 'door', 'door', 'off', '2026-11-02T16:10:00Z'),
    ]);
    expect(rows.map((r) => r.type + ':' + r.name)).toEqual(['value:temp', 'span:presence', 'span:door', 'change:door']);
    const span = rows.find((r) => r.type === 'span' && r.name === 'door')!;
    expect(span.type === 'span' && [span.end, span.seconds]).toEqual(['2026-11-02T16:25:10Z', 37]);
    expect(rows.find((r) => r.name === 'presence')).toMatchObject({ end: null });
  });
  it('says how long in words people read', () => {
    expect(shortDuration(37)).toBe('37 s');
    expect(shortDuration(240)).toBe('4 min');
    expect(shortDuration(7500)).toBe('2 h 5 min');
  });
  it('a day in Colombo is 18:30 to 18:30 UTC', () => {
    expect(dayRange('2026-11-02', 'Asia/Colombo')).toEqual({ from: '2026-11-01T18:30:00.000Z', to: '2026-11-02T18:30:00.000Z' });
    expect(localDay('2026-11-01T19:00:00Z', 'Asia/Colombo')).toBe('2026-11-02');
  });
});
