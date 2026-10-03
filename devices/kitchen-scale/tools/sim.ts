// A software kitchen scale: speaks protocol v1 (docs/kitchen-scale/protocol.md) exactly like the
// firmware, so Gedara can be tested end to end with no hardware — by the e2e tests (import ScaleSim)
// and by hand:
//
//   node devices/kitchen-scale/tools/sim.ts --project staging --token-file <file with the token>
//   > put 04A1B2C3D4E5F6 1188        jar on the scale (uid, gross grams[, HL:LOC:code])
//   > lift                           platform empty again
//   > offline on|off                 queue readings like the real outbox, send them later
//   > sync | status | quit
//
// The token is read from a file or GEDARA_SCALE_TOKEN and never printed. Commands from Gedara
// (beep, identify, tare, calibrate) are acknowledged like the firmware does. Plain TypeScript, no
// dependencies: Node 24 runs it directly, Playwright imports it.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PROJECTS: Record<string, string> = {
  staging: 'https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/scale-ingest',
  prod: 'https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/scale-ingest',
};

export interface SimEvent {
  seq: number;
  b: number;
  t: number;
  at?: number;
  type: 'weigh';
  uid?: string;
  ndef?: string;
  gross_g: number;
}

export interface SimCommand {
  id: string;
  command: string;
  args: Record<string, unknown>;
}

export interface SimReply {
  ok: boolean;
  error?: string;
  acked?: number[];
  results?: Array<Record<string, unknown> & { seq?: number; status: string }>;
  commands?: SimCommand[];
  containers?: { v: string; items?: unknown[] };
  poll_ms?: number;
  [k: string]: unknown;
}

export interface SimOptions {
  url: string;
  token: string;
  epoch?: number;
  fw?: string;
  /** Leave out `at` (a scale whose clock isn't set yet): the server estimates it from uptime. */
  noClock?: boolean;
}

export class ScaleSim {
  readonly url: string;
  readonly epoch: number;
  readonly fw: string;
  private readonly token: string;
  private readonly noClock: boolean;
  private readonly started = Date.now();
  readonly boot = 1;
  private seq = 0;
  outbox: SimEvent[] = [];
  offline = false;
  private done: Array<{ id: string; ok: boolean; result?: Record<string, number | string | boolean | null> }> = [];
  private containersV: string | undefined;
  last: SimReply | null = null;

  constructor(o: SimOptions) {
    this.url = o.url;
    this.token = o.token;
    this.epoch = o.epoch ?? Math.floor(Math.random() * 0xffffffff);
    this.fw = o.fw ?? '0.0.0-sim';
    this.noClock = o.noClock ?? false;
  }

  up(): number {
    return Date.now() - this.started;
  }

  /** A stable weighing: queued, then sent unless offline. Returns the server's result for it. */
  async weigh(uid: string | undefined, gross_g: number, ndef?: string): Promise<Record<string, unknown> | null> {
    const e: SimEvent = { seq: ++this.seq, b: this.boot, t: this.up(), type: 'weigh', gross_g };
    if (!this.noClock) e.at = Date.now();
    if (uid) e.uid = uid.toUpperCase();
    if (ndef) e.ndef = ndef;
    this.outbox.push(e);
    if (this.offline) return null;
    const reply = await this.sync({ live: { state: 'stable', ...(uid ? { uid: e.uid } : {}), gross_g } });
    return reply.results?.find((r) => r.seq === e.seq) ?? null;
  }

  /** One request: status, up to 20 queued readings, finished commands. Acked readings leave the outbox. */
  async sync(extra: Record<string, unknown> = {}): Promise<SimReply> {
    const body = {
      v: 1,
      fw: this.fw,
      epoch: this.epoch,
      boot: this.boot,
      up: this.up(),
      status: { rssi: -55, heap: 200000, heap_min: 180000, queue: this.outbox.length, reset: 'poweron', time_ok: !this.noClock },
      events: this.outbox.slice(0, 20),
      done: this.done.splice(0),
      ...(this.containersV ? { containers_v: this.containersV } : {}),
      ...extra,
    };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gedara-Device': this.token },
      body: JSON.stringify(body),
    });
    const reply = (await res.json()) as SimReply;
    this.last = reply;
    if (!reply.ok) return reply;
    const acked = new Set(reply.acked ?? []);
    this.outbox = this.outbox.filter((e) => !acked.has(e.seq));
    if (reply.containers?.v) this.containersV = reply.containers.v;
    for (const c of reply.commands ?? []) this.done.push(this.run(c));
    return reply;
  }

  /** Platform empty again (live only, like the firmware: nothing is queued). */
  async lift(): Promise<SimReply | null> {
    if (this.offline) return null;
    return this.sync({ live: { state: 'empty', gross_g: 0 } });
  }

  private run(c: SimCommand): { id: string; ok: boolean; result?: Record<string, number | string | boolean | null> } {
    switch (c.command) {
      case 'calibrate':
        return { id: c.id, ok: true, result: { factor: -412.37, zero: 84213, known_g: Number(c.args.known_g ?? 0) } };
      case 'tare':
        return { id: c.id, ok: true, result: { zero: 84213 } };
      case 'beep':
      case 'identify':
        return { id: c.id, ok: true };
      default:
        return { id: c.id, ok: false, result: { error: 'not in the simulator' } };
    }
  }
}

// ── Command line ──────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const project = arg('project') ?? 'staging';
  const url = arg('url') ?? PROJECTS[project];
  const tokenFile = arg('token-file');
  const token = (tokenFile ? readFileSync(tokenFile, 'utf8') : (process.env.GEDARA_SCALE_TOKEN ?? '')).trim();
  if (!url || !/^https:\/\//.test(url)) throw new Error('use --project staging|prod or --url https://…');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('no token: --token-file <file> or GEDARA_SCALE_TOKEN');

  const sim = new ScaleSim({ url, token });
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 1));
  console.log(`Fake scale → ${url} (epoch ${sim.epoch}). Type: put <uid> <grams> [code] · lift · offline on|off · sync · status · quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'scale> ' });
  rl.prompt();
  for await (const line of rl) {
    const [cmd, a, b, c] = line.trim().split(/\s+/);
    try {
      if (cmd === 'put' && a && b) show(await sim.weigh(a === '-' ? undefined : a, Number(b), c));
      else if (cmd === 'lift') await sim.lift();
      else if (cmd === 'offline') sim.offline = a === 'on';
      else if (cmd === 'sync') show(await sim.sync());
      else if (cmd === 'status') show({ queued: sim.outbox.length, offline: sim.offline, last: sim.last?.ok });
      else if (cmd === 'quit' || cmd === 'exit') break;
      else if (cmd) console.log('?');
    } catch (e) {
      console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
  }
  rl.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
