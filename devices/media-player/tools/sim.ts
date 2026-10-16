// A software music speaker: speaks the media-agent protocol (docs/media-player/protocol.md) like
// gedara-media-agent on the Raspberry Pi, so Gedara Music can be tested end to end with no Pi — by
// the e2e tests (import SpeakerSim) and by hand:
//
//   node devices/media-player/tools/sim.ts --project staging
//   pairing code: 482913          ← type it in Gedara › Settings › Devices › Add speaker
//   > status | quit
//
// It makes its own key like the agent (never printed), "plays" by keeping a clock instead of sound,
// downloads songs from their signed links and checks their sha256, and reports what it's doing after
// every command. Plain TypeScript, no dependencies: Node 24 runs it directly, Playwright imports it.
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PROJECTS: Record<string, string> = {
  staging: 'https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/media-agent',
  prod: 'https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/media-agent',
};

export interface SimCommand {
  id: string;
  command: string;
  args: Record<string, unknown>;
}
export interface SimSong {
  id: string;
  file: string;
}
export interface SimReply {
  ok: boolean;
  error?: string;
  device_id?: string;
  commands?: SimCommand[];
  downloads?: { id: string; path: string; sha256: string; size_bytes: number; mime: string; url?: string }[];
  deletions?: { id: string; file: string | null }[];
  sync_now?: boolean;
  [k: string]: unknown;
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

export class SpeakerSim {
  readonly key = randomBytes(32).toString('base64url');
  readonly started = Date.now();
  /** When each command arrived (ms since epoch), for latency checks. */
  readonly received: Array<SimCommand & { at: number }> = [];
  files = new Map<string, string>(); // track id → file on the "card"
  player = {
    state: 'stopped' as 'stopped' | 'playing' | 'paused',
    queue: [] as SimSong[],
    index: 0,
    elapsed: 0,
    since: 0,
    volume: 50,
    sleepUntil: null as number | null,
    shuffle: false,
    repeat: 'off' as 'off' | 'all' | 'one',
  };
  /** Commands this sim ignores (to test "the speaker didn't answer"). */
  deaf = false;
  /** Another source playing (Phase 7i): AirPlay or Bluetooth from a phone. */
  external: { source: 'airplay' | 'bluetooth'; name: string } | null = null;
  btPairingUntil = 0;
  private done: { id: string; ok: boolean; error?: string }[] = [];
  private downloaded: { id: string; ok: boolean; file?: string; error?: string }[] = [];
  private deleted: string[] = [];
  private running = false;

  constructor(readonly url: string) {}

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
      { action: 'pair_start', key_hash: createHash('sha256').update(this.key).digest('hex'), hint: this.key.slice(-4), agent: 'gedara-media sim' },
      false,
    );
    if (!r.ok || typeof r.code !== 'string') throw new Error(`pair_start: ${JSON.stringify(r)}`);
    return r.code;
  }

  async pairPoll(): Promise<string> {
    const r = await this.post({ action: 'pair_poll' });
    return String(r.status);
  }

  private elapsed(): number {
    const p = this.player;
    return p.state === 'playing' ? p.elapsed + (Date.now() - p.since) / 1000 : p.elapsed;
  }

  private report() {
    const p = this.player;
    const song = p.queue[p.index];
    return {
      state: p.state,
      track_id: p.state === 'stopped' || !song ? null : song.id,
      elapsed_s: Math.round(this.elapsed() * 10) / 10,
      duration_s: song ? 180 : null,
      volume: p.volume,
      sleep_until_ms: p.sleepUntil,
      shuffle: p.shuffle,
      repeat: p.repeat,
      queue: p.queue.map((s) => s.id),
      queue_index: song ? p.index : null,
      source: this.external?.source ?? 'gedara',
      source_name: this.external?.name ?? null,
    };
  }

  private apply(c: SimCommand) {
    const p = this.player;
    const a = c.args;
    const pin = () => {
      p.elapsed = this.elapsed();
      p.since = Date.now();
    };
    switch (c.command) {
      case 'play':
        this.external = null; // Gedara takes the speaker back
        p.queue = (a.queue as SimSong[]) ?? [];
        p.index = Number(a.index ?? 0);
        p.state = 'playing';
        p.elapsed = 0;
        p.since = Date.now();
        break;
      case 'pause':
        pin();
        p.state = 'paused';
        break;
      case 'resume':
        if (p.queue.length) {
          p.since = Date.now();
          p.state = 'playing';
        }
        break;
      case 'stop':
        p.state = 'stopped';
        p.elapsed = 0;
        break;
      case 'next':
      case 'prev':
        p.index = Math.max(0, Math.min(p.queue.length - 1, p.index + (c.command === 'next' ? 1 : -1)));
        p.elapsed = 0;
        p.since = Date.now();
        break;
      case 'seek':
        p.elapsed = Number(a.s);
        p.since = Date.now();
        break;
      case 'volume':
        p.volume = Number(a.v);
        break;
      case 'sleep':
        p.sleepUntil = Number(a.minutes) > 0 ? Date.now() + Number(a.minutes) * 60_000 : null;
        break;
      case 'shuffle':
        p.shuffle = Boolean(a.on);
        break;
      case 'repeat':
        p.repeat = a.mode as typeof p.repeat;
        break;
      case 'bt_pair':
        this.btPairingUntil = Date.now() + Number(a.seconds ?? 120) * 1000;
        break;
      default:
        break;
    }
  }

  private async downloads(r: SimReply) {
    for (const d of r.downloads ?? []) {
      try {
        if (!d.url) throw new Error('no link');
        const bytes = new Uint8Array(await (await fetch(d.url)).arrayBuffer());
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== d.sha256.toLowerCase()) throw new Error('sha256 mismatch');
        const file = `inbox/${d.id}.${EXT[d.mime] ?? 'bin'}`;
        this.files.set(d.id, file);
        this.downloaded.push({ id: d.id, ok: true, file });
      } catch (e) {
        this.downloaded.push({ id: d.id, ok: false, error: e instanceof Error ? e.message : 'failed' });
      }
    }
    for (const d of r.deletions ?? []) {
      this.files.delete(d.id);
      this.deleted.push(d.id);
    }
  }

  /** One sync. Commands are carried out; finished downloads, deletions and commands go in the next. */
  async sync(wait = false): Promise<SimReply> {
    const body: Record<string, unknown> = {
      action: 'sync',
      v: 1,
      agent: 'gedara-media sim',
      up: Math.floor((Date.now() - this.started) / 1000),
      wait,
      status: { output: 'none', mpd: true, files: this.files.size, airplay: true, bluetooth: Date.now() < this.btPairingUntil ? 'pairing' : 'ready', bt_devices: [] },
      player: this.report(),
    };
    if (this.done.length) body.done = this.done.splice(0);
    if (this.downloaded.length) body.downloaded = this.downloaded.splice(0);
    if (this.deleted.length) body.deleted = this.deleted.splice(0);
    const r = await this.post(body);
    if (!r.ok) return r;
    for (const c of r.commands ?? []) {
      this.received.push({ ...c, at: Date.now() });
      if (this.deaf) continue;
      this.apply(c);
      this.done.push({ id: c.id, ok: true });
    }
    await this.downloads(r);
    return r;
  }

  /** Keeps a long-poll open like the agent; reports back at once after anything happened. */
  start() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const busy = this.done.length || this.downloaded.length || this.deleted.length;
          const r = await this.sync(!busy);
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
  const sim = new SpeakerSim(PROJECTS[arg('--project') ?? 'staging'] ?? arg('--url') ?? '');
  const code = await sim.pairStart();
  console.log(`pairing code: ${code}   (Gedara › Settings › Devices › Music speakers › Add speaker)`);
  while ((await sim.pairPoll()) !== 'paired') await new Promise((r) => setTimeout(r, 2000));
  console.log('paired — playing along with Gedara (status | quit)');
  sim.start();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', (l) => {
    if (l.trim() === 'quit') {
      sim.stop();
      rl.close();
      return;
    }
    console.log(JSON.stringify({ player: sim.player, files: sim.files.size, commands: sim.received.length }));
    rl.prompt();
  });
}
