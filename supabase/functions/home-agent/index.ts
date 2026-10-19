// home-agent — the Home Assistant bridge's one endpoint (Phase 8, docs/home-assistant/protocol.md).
//
// Caller: gedara-home on the Gedara Raspberry Pi, which talks to Home Assistant on the home network.
// Pairing starts without a key (pair_start sends only the sha256 of the key the Pi made for itself);
// everything after that carries the header `X-Gedara-Device: <key>`, whose sha256 finds the bridge
// in the service-role-only RPCs (rpc_home_pair_poll / rpc_home_sync / rpc_home_wait /
// rpc_home_pending). verify_jwt is off: the Pi holds no Supabase key of any kind, and the Home
// Assistant token never leaves the Pi.
//
// sync with `wait: true` is a long-poll: when there is nothing to do it keeps the request open for
// up to 25 s, waiting inside Postgres (rpc_home_wait: every 0.3 s, at most 7 s per call because
// PostgREST's statement_timeout is 8 s), so a tap in Gedara reaches the bridge in about a second
// for ~5 logged requests per quiet 25 s (Log Ingestion is Gedara's tightest quota). Success is
// logged only when something happened. Payloads are Zod-validated (rule 6); logs and replies never
// contain the key. Bump FN_VERSION on every deploy of this function.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';
import { corsHeaders, json, readBody, rpcError, sha256Hex, sleep, sourceHash } from '../_shared/device/http.ts';
import { DeviceKey, PairStart, PROTOCOL_VERSION, SyncRequest, type HomeCommand } from '../_shared/home/protocol.ts';

const FN_VERSION = 'home-agent-1';
const MAX_BYTES = 262_144; // a full catalog of 400 entities with their states
const WAIT_MS = 25_000;
const WAIT_CHUNK_MS = 7_000; // one rpc_home_wait: under PostgREST's 8 s statement_timeout

function admin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function invalid(path: (string | number | symbol)[] | undefined, action: string) {
  // Which field, never its value — enough for Diagnostics, nothing private.
  const p = (path ?? []).map(String).join('.');
  console.log(JSON.stringify({ fn: FN_VERSION, action, error: 'invalid', path: p }));
  return json({ ok: false, error: 'invalid', path: p }, 400);
}

async function sync(req: Request, db: SupabaseClient, keyHash: string, raw: unknown): Promise<Response> {
  const started = Date.now();
  const parsed = SyncRequest.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path, 'sync');
  const { action: _a, v: _v, wait, ...payload } = parsed.data;

  const { data, error } = await db.rpc('rpc_home_sync', { p_token_hash: keyHash, p: payload });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, action: 'sync', error: error.code }));
    return rpcError(error.code);
  }
  const reply = data as { device_id: string; name: string; commands: HomeCommand[]; need_catalog: boolean };

  // Long-poll: nothing to do yet → wait for a command, up to 25 s.
  let waited = 0;
  if (wait && !reply.commands.length) {
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until - 100 && !req.signal.aborted) {
      const { data: something, error: we } = await db.rpc('rpc_home_wait', {
        p_token_hash: keyHash,
        p_ms: Math.min(WAIT_CHUNK_MS, until - Date.now()),
      });
      if (we) {
        console.log(JSON.stringify({ fn: FN_VERSION, action: 'wait', error: we.code }));
        await sleep(1000); // never a tight loop of failing calls
        break;
      }
      if (!something) continue;
      const { data: p, error: pe } = await db.rpc('rpc_home_pending', { p_token_hash: keyHash });
      if (pe) break;
      const pending = (p as { commands: HomeCommand[] }).commands;
      if (pending.length) {
        reply.commands = pending;
        break;
      }
    }
    waited = Date.now() - started;
  }

  if (reply.commands.length || payload.done?.length || payload.catalog) {
    console.log(
      JSON.stringify({
        fn: FN_VERSION,
        action: 'sync',
        commands: reply.commands.map((c) => c.action),
        done: payload.done?.length ?? 0,
        catalog: payload.catalog?.length,
        waited,
        ms: Date.now() - started,
      }),
    );
  }
  return json({ ok: true, fn_version: FN_VERSION, ...reply });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION, protocol: PROTOCOL_VERSION });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  try {
    const raw = await readBody(req, MAX_BYTES);
    if (raw instanceof Response) return raw;
    const action = (raw as { action?: unknown } | null)?.action;
    const db = admin();

    if (action === 'pair_start') {
      const parsed = PairStart.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.path, 'pair_start');
      const { data, error } = await db.rpc('rpc_home_pair_start', {
        p_token_hash: parsed.data.key_hash.toLowerCase(),
        p_hint: parsed.data.hint,
        p_agent: parsed.data.agent ?? null,
        p_source: await sourceHash(req),
      });
      if (error) {
        console.log(JSON.stringify({ fn: FN_VERSION, action, error: error.code }));
        return rpcError(error.code);
      }
      console.log(JSON.stringify({ fn: FN_VERSION, action, status: (data as { status: string }).status }));
      return json({ ok: true, fn_version: FN_VERSION, ...(data as object) });
    }

    const key = DeviceKey.safeParse((req.headers.get('x-gedara-device') ?? '').trim());
    if (!key.success) return json({ ok: false, error: 'unauthorized' }, 401);
    const keyHash = await sha256Hex(key.data);

    if (action === 'pair_poll') {
      const { data, error } = await db.rpc('rpc_home_pair_poll', { p_token_hash: keyHash });
      if (error) return rpcError(error.code);
      return json({ ok: true, fn_version: FN_VERSION, ...(data as object) });
    }
    if (action === 'sync') return await sync(req, db, keyHash, raw);
    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: e instanceof Error ? e.name : 'unknown' }));
    return json({ ok: false, error: 'server' }, 500);
  }
});
