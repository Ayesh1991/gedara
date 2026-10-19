// A software Home Assistant bridge: speaks the home-agent protocol (docs/home-assistant/protocol.md)
// like gedara-home on the Pi, with a pretend Home Assistant behind it, so Gedara's House page can be
// tested end to end with no Pi and no HA — by the e2e tests (import BridgeSim) and by hand:
//
//   node devices/home-bridge/tools/sim.ts --project staging
//   pairing code: 48291307        ← type it in Gedara › Settings › Devices › Home Assistant › Connect
//   > open Bedroom Window 2 | close … | status | quit
//
// It makes its own key like the bridge (never printed) and refuses what the real bridge refuses
// (anything but switch/light on-off and the four climate commands, temperatures outside the AC's
// range, modes it doesn't have). Plain TypeScript, no dependencies: Node 24 runs it directly.
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PROJECTS: Record<string, string> = {
  staging: 'https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/home-agent',
  prod: 'https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/home-agent',
};

export interface SimCommand {
  id: string;
  entity_id: string;
  action: string;
  args: { temperature?: number; hvac_mode?: string };
}
export interface SimReply {
  ok: boolean;
  error?: string;
  device_id?: string;
  commands?: SimCommand[];
  need_catalog?: boolean;
  [k: string]: unknown;
}
export interface SimEntity {
  entity_id: string;
  domain: 'binary_sensor' | 'light' | 'switch' | 'climate';
  kind: 'door' | 'window' | 'light' | 'switch' | 'climate';
  name: string;
  area: string | null;
  state: string;
  attrs?: Record<string, unknown>;
}

/** A small house like Didula's: two rooms, windows, a door, lights, the vaporizer, the emergency light, an AC. */
export function demoHouse(prefix = ''): SimEntity[] {
  const id = (s: string) => `${s.split('.')[0]}.${prefix}${s.split('.')[1]}`;
  return [
    { entity_id: id('binary_sensor.bedroom_window_1'), domain: 'binary_sensor', kind: 'window', name: 'Bedroom Window 1', area: 'Bedroom', state: 'off' },
    { entity_id: id('binary_sensor.bedroom_window_2'), domain: 'binary_sensor', kind: 'window', name: 'Bedroom Window 2', area: 'Bedroom', state: 'off' },
    { entity_id: id('binary_sensor.front_door'), domain: 'binary_sensor', kind: 'door', name: 'Front door', area: 'Living Room', state: 'off' },
    { entity_id: id('light.bedroom_mist_rgb'), domain: 'light', kind: 'light', name: 'Mist maker Mist RGB Light', area: 'Bedroom', state: 'off' },
    { entity_id: id('switch.mosquito_vaporizer'), domain: 'switch', kind: 'switch', name: 'Mosquito Vaporizer', area: 'Bedroom', state: 'off' },
    { entity_id: id('switch.living_room_emergency_light'), domain: 'switch', kind: 'switch', name: 'Living Room Emergency Light', area: 'Living Room', state: 'off' },
    {
      entity_id: id('climate.bedroom_ac'), domain: 'climate', kind: 'climate', name: 'AC', area: 'Bedroom', state: 'off',
      attrs: { current_temperature: 28.9, temperature: 27, min_temp: 16, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'cool', 'dry', 'fan_only'] },
    },
  ];
}

const ALLOWED = new Set(['switch.turn_on', 'switch.turn_off', 'light.turn_on', 'light.turn_off', 'climate.turn_on', 'climate.turn_off',
  'climate.set_temperature', 'climate.set_hvac_mode']);

export class BridgeSim {
  readonly key = randomBytes(32).toString('base64url');
  readonly started = Date.now();
  /** When each command arrived (ms since epoch), for latency checks. */
  readonly received: Array<SimCommand & { at: number }> = [];
  readonly refused: SimCommand[] = [];
  entities: SimEntity[];
  /** Commands this sim ignores (to test "Home Assistant didn't answer"). */
  deaf = false;
  deviceId: string | null = null;
  private done: { id: string; ok: boolean; error?: string }[] = [];
  private changed = new Set<string>();
  private catalogDirty = true;
  private running = false;

  readonly url: string;

  constructor(url: string, entities: SimEntity[] = demoHouse()) {
    this.url = url; // (no parameter properties: Node runs this file directly)
    this.entities = entities;
    for (const e of entities) this.changed.add(e.entity_id);
  }

  private async post(body: Record<string, unknown>, withKey = true): Promise<SimReply> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(withKey ? { 'X-Gedara-Device': this.key } : {}) },
      body: JSON.stringify(body),
    });
    return (await res.json()) as SimReply;
  }

  async pairStart(): Promise<string> {
    const r = await this.post(
      { action: 'pair_start', key_hash: createHash('sha256').update(this.key).digest('hex'), hint: this.key.slice(-4), agent: 'gedara-home sim' },
      false,
    );
    if (!r.ok || typeof r.code !== 'string') throw new Error(`pair_start: ${JSON.stringify(r)}`);
    return r.code;
  }

  async pairPoll(): Promise<string> {
    const r = await this.post({ action: 'pair_poll' });
    return String(r.status);
  }

  entity(entityId: string): SimEntity {
    const e = this.entities.find((x) => x.entity_id === entityId || x.name === entityId);
    if (!e) throw new Error(`no entity ${entityId}`);
    return e;
  }

  /** Something changes in the house (a window opens …): reported in the next sync. */
  set(entityId: string, state: string, attrs?: Record<string, unknown>) {
    const e = this.entity(entityId);
    e.state = state;
    if (attrs) e.attrs = { ...e.attrs, ...attrs };
    this.changed.add(e.entity_id);
  }

  private apply(c: SimCommand): string | null {
    const e = this.entities.find((x) => x.entity_id === c.entity_id);
    if (!e) return 'refused by the bridge: not something this bridge reports';
    if (!ALLOWED.has(`${e.domain}.${c.action}`)) return `refused by the bridge: ${e.domain}.${c.action} is not allowed from Gedara`;
    const a = e.attrs ?? {};
    if (c.action === 'turn_on') e.state = e.domain === 'climate' ? 'cool' : 'on';
    else if (c.action === 'turn_off') e.state = 'off';
    else if (c.action === 'set_temperature') {
      const t = c.args.temperature ?? NaN;
      if (!(t >= Number(a.min_temp ?? 16) && t <= Number(a.max_temp ?? 32))) return 'refused by the bridge: temperature out of range';
      e.attrs = { ...a, temperature: t };
    } else if (c.action === 'set_hvac_mode') {
      if (!(a.hvac_modes as string[] | undefined)?.includes(c.args.hvac_mode ?? '')) return 'refused by the bridge: no such mode';
      e.state = c.args.hvac_mode!;
    }
    this.changed.add(e.entity_id);
    return null;
  }

  /** One sync. Commands are carried out; their results and the changes go in the next. */
  async sync(wait = false): Promise<SimReply> {
    const body: Record<string, unknown> = {
      action: 'sync',
      v: 1,
      agent: 'gedara-home sim',
      up: Math.floor((Date.now() - this.started) / 1000),
      wait,
      status: { ha: 'connected', ha_version: '2026.10.0', entities: this.entities.length },
    };
    if (this.catalogDirty) {
      body.catalog = this.entities.map(({ entity_id, domain, kind, name, area }) => ({ entity_id, domain, kind, name, area }));
      body.catalog_full = true;
    }
    const states = this.entities.filter((e) => this.changed.has(e.entity_id));
    if (states.length) body.states = states.map((e) => ({ entity_id: e.entity_id, state: e.state, ...(e.attrs ? { attrs: e.attrs } : {}) }));
    if (this.done.length) body.done = this.done.splice(0);
    if (body.catalog || body.states || body.done) body.wait = false;
    this.changed.clear();
    const r = await this.post(body);
    if (!r.ok) return r;
    this.catalogDirty = !!r.need_catalog;
    if (typeof r.device_id === 'string') this.deviceId = r.device_id;
    for (const c of r.commands ?? []) {
      this.received.push({ ...c, at: Date.now() });
      if (this.deaf) continue;
      const err = this.apply(c);
      if (err) this.refused.push(c);
      this.done.push({ id: c.id, ok: !err, ...(err ? { error: err } : {}) });
    }
    return r;
  }

  get busy() {
    return this.done.length > 0 || this.changed.size > 0 || this.catalogDirty;
  }

  /** Keeps a long-poll open like the bridge; reports back at once after anything happened. */
  start() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const r = await this.sync(!this.busy);
          if (!r.ok) await new Promise((res) => setTimeout(res, 1000));
        } catch {
          await new Promise((res) => setTimeout(res, 1000));
        }
      }
    })();
  }

  stop() {
    this.running = false;
  }
}

// ── By hand ───────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const sim = new BridgeSim(PROJECTS[arg('--project') ?? 'staging'] ?? arg('--url') ?? '');
  const code = await sim.pairStart();
  console.log(`pairing code: ${code}   (Gedara › Settings › Devices › Home Assistant › Connect)`);
  while ((await sim.pairPoll()) !== 'paired') await new Promise((r) => setTimeout(r, 2000));
  console.log('paired — a pretend house (open <name> | close <name> | status | quit)');
  sim.start();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', (l) => {
    const [cmd, ...rest] = l.trim().split(' ');
    try {
      if (cmd === 'quit') {
        sim.stop();
        rl.close();
        return;
      }
      if (cmd === 'open' || cmd === 'close') sim.set(rest.join(' '), cmd === 'open' ? 'on' : 'off');
      else console.log(JSON.stringify(sim.entities.map((e) => `${e.name}: ${e.state}`)));
    } catch (e) {
      console.log(String(e));
    }
    rl.prompt();
  });
}
