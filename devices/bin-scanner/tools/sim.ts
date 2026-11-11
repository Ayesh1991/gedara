// A software bin scanner: speaks protocol v1 (docs/bin-scanner/protocol.md) exactly like the
// firmware, so Gedara can be tested end to end with no hardware — by the e2e tests (import
// ScannerSim) and by hand:
//
//   node devices/bin-scanner/tools/sim.ts --project staging --token-file <file with the key>
//   > scan 4792210100125          a pack in the current mode (Used unless you pressed a letter)
//   > key B | key C | key D | key # | key A     Add · Opened · Waste · Check · back to Used
//   > key 3                       how many for the next scan
//   > key *                       undo this scanner's last scan
//   > offline on|off              queue scans like the real outbox, send them later
//   > sync | status | quit
//
// The key is read from a file or GEDARA_SCANNER_TOKEN and never printed. Commands from Gedara
// (beep, identify) are acknowledged like the firmware does. Plain TypeScript, no dependencies:
// Node 24 runs it directly, Playwright imports it.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PROJECTS: Record<string, string> = {
  staging: 'https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/scanner-ingest',
  prod: 'https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/scanner-ingest',
};

export type SimMode = 'use' | 'add' | 'open' | 'waste' | 'check';

export type SimEvent =
  | { seq: number; b: number; t: number; at?: number; type: 'scan'; mode: SimMode; n?: number; code: string }
  | { seq: number; b: number; t: number; at?: number; type: 'undo' };

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
  cat?: { v: string; items?: [string, string][] };
  config?: Record<string, unknown>;
  paused?: boolean;
  next_ms?: number;
  [k: string]: unknown;
}

export interface SimOptions {
  url: string;
  token: string;
  epoch?: number;
  fw?: string;
  /** Leave out `at` (a scanner whose clock isn't set yet): the server estimates it from uptime. */
  noClock?: boolean;
}

const KEY_MODES: Record<string, SimMode> = { A: 'use', B: 'add', C: 'open', D: 'waste', '#': 'check' };

export class ScannerSim {
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
  mode: SimMode = 'use';
  count = 1;
  /** The names list, as the firmware keeps it. */
  names = new Map<string, string>();
  private catV: string | undefined;
  private done: Array<{ id: string; ok: boolean; result?: Record<string, number | string | boolean | null> }> = [];
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

  private stamp(): { seq: number; b: number; t: number; at?: number } {
    return { seq: ++this.seq, b: this.boot, t: this.up(), ...(this.noClock ? {} : { at: Date.now() }) };
  }

  /** A key press: a letter or # changes the mode, digits set the count, * queues an undo. */
  async key(k: string): Promise<Record<string, unknown> | null> {
    const key = k.toUpperCase();
    if (KEY_MODES[key]) {
      this.mode = KEY_MODES[key];
      return null;
    }
    if (/^[0-9]$/.test(key)) {
      const n = this.count > 1 ? this.count * 10 + Number(key) : Number(key);
      this.count = n === 0 ? 1 : n > 20 ? Number(key) || 1 : n;
      return null;
    }
    if (key === '*') {
      const e: SimEvent = { ...this.stamp(), type: 'undo' };
      this.outbox.push(e);
      if (this.offline) return null;
      const reply = await this.sync();
      return reply.results?.find((r) => r.seq === e.seq) ?? null;
    }
    return null;
  }

  /** A code read in the current mode: queued, then sent unless offline. Returns the server's result for it. */
  async scan(code: string, mode: SimMode = this.mode, n: number = this.count): Promise<Record<string, unknown> | null> {
    const e: SimEvent = { ...this.stamp(), type: 'scan', mode, ...(n > 1 ? { n } : {}), code };
    this.count = 1;
    this.outbox.push(e);
    if (this.offline) return null;
    const reply = await this.sync();
    return reply.results?.find((r) => r.seq === e.seq) ?? null;
  }

  /** One request: status, up to 20 queued events, finished commands. Acked events leave the outbox. */
  async sync(extra: Record<string, unknown> = {}): Promise<SimReply> {
    const body = {
      v: 1,
      fw: this.fw,
      epoch: this.epoch,
      boot: this.boot,
      up: this.up(),
      status: { rssi: -55, heap: 200000, heap_min: 180000, queue: this.outbox.length, reset: 'poweron', time_ok: !this.noClock, eye: 'sense', names: this.names.size },
      events: this.outbox.slice(0, 20),
      done: this.done.splice(0),
      ...(this.catV ? { cat_v: this.catV } : {}),
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
    if (reply.cat?.items) this.names = new Map(reply.cat.items);
    if (reply.cat?.v) this.catV = reply.cat.v;
    for (const c of reply.commands ?? []) this.done.push(this.run(c));
    return reply;
  }

  private run(c: SimCommand): { id: string; ok: boolean; result?: Record<string, number | string | boolean | null> } {
    switch (c.command) {
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
  const token = (tokenFile ? readFileSync(tokenFile, 'utf8') : (process.env.GEDARA_SCANNER_TOKEN ?? '')).trim();
  if (!url || !/^https:\/\//.test(url)) throw new Error('use --project staging|prod or --url https://…');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('no key: --token-file <file> or GEDARA_SCANNER_TOKEN');

  const sim = new ScannerSim({ url, token });
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 1));
  console.log(`Fake bin scanner → ${url} (epoch ${sim.epoch}). Type: scan <code> · key <A-D # * 0-9> · offline on|off · sync · status · quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'scanner> ' });
  rl.prompt();
  for await (const line of rl) {
    const [cmd, a] = line.trim().split(/\s+/);
    try {
      if (cmd === 'scan' && a) show(await sim.scan(line.trim().slice(5)));
      else if (cmd === 'key' && a) {
        const r = await sim.key(a);
        if (r) show(r);
        else console.log(`mode ${sim.mode}${sim.count > 1 ? ` ×${sim.count}` : ''}`);
      } else if (cmd === 'offline') sim.offline = a === 'on';
      else if (cmd === 'sync') {
        const r = await sim.sync();
        show({ ok: r.ok, error: r.error, acked: r.acked, results: r.results, commands: r.commands, paused: r.paused, next_ms: r.next_ms, names: sim.names.size });
      } else if (cmd === 'status') show({ mode: sim.mode, count: sim.count, queued: sim.outbox.length, offline: sim.offline, names: sim.names.size, last: sim.last?.ok });
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
