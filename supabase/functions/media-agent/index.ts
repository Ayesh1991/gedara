// media-agent — the music speaker's one endpoint (Phase 7h, docs/media-player/protocol.md).
//
// Caller: gedara-media-agent on the Raspberry Pi. Pairing starts without a key (pair_start sends
// only the sha256 of the key the Pi made for itself); everything after that carries the header
// `X-Gedara-Device: <key>`, whose sha256 finds the speaker in the service-role-only RPCs
// (rpc_media_pair_poll / rpc_media_sync / rpc_media_pending / rpc_media_trash_done). verify_jwt is
// off (the Pi has no Supabase session and holds no Supabase key of any kind).
//
// sync with `wait: true` is a long-poll: when there is nothing to do it keeps the request open for
// up to 25 s, checking for commands every 0.7 s, so a tap on Play in Gedara reaches the speaker in
// about a second while costing ~1 invocation per 25 s. Songs waiting in `media-inbox` are handed
// over as links signed for 15 minutes; inbox files the speaker no longer needs are deleted here.
// Payloads are Zod-validated (rule 6); logs and replies never contain the key. Bump FN_VERSION on
// every deploy of this function.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';
import { ArtUpload, DeviceKey, PairStart, PROTOCOL_VERSION, SyncRequest, type Download, type MediaCommand } from '../_shared/media/protocol.ts';

const FN_VERSION = 'media-agent-1';
const MAX_BYTES = 65_536;
const LINK_SECONDS = 900;
const WAIT_MS = 25_000;
const POLL_MS = 700;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rpcStatus(code: string | undefined): number {
  if (code === '42501') return 401;
  if (code === 'GDRTE') return 429;
  if (code === '23514' || code === '22P02' || code === '22003') return 400;
  return 500;
}

function rpcError(code: string | undefined) {
  const status = rpcStatus(code);
  return json({ ok: false, error: status === 401 ? 'unauthorized' : status === 429 ? 'slow_down' : 'rejected' }, status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Supabase Edge Runtime: finish work after the reply has been sent.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
function later(p: Promise<unknown>) {
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
  return typeof EdgeRuntime !== 'undefined' ? Promise.resolve() : p;
}

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

/** The body, read as a stream that stops at MAX_BYTES (a missing or false Content-Length can't get past it). */
async function readBody(req: Request): Promise<unknown | Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  if (!req.body) return json({ ok: false, error: 'bad_json' }, 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return json({ ok: false, error: 'too_large' }, 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
}

/**
 * sha256 of the caller's IP: pairing is limited per caller without keeping the address itself.
 * Supabase's edge sits behind Cloudflare, which sets cf-connecting-ip itself (a client can't choose
 * it); otherwise the last X-Forwarded-For hop, the one our own proxy added. No address at all counts
 * in one shared "unknown" bucket, so a missing header never skips the limit.
 */
async function sourceHash(req: Request): Promise<string> {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return await sha256Hex(`gedara-pairing:${cf || xff || 'unknown'}`);
}

type SyncData = {
  commands: MediaCommand[];
  downloads: Download[];
  deletions: { id: string; file: string | null }[];
  trash: string[];
} & Record<string, unknown>;

async function sync(req: Request, db: SupabaseClient, keyHash: string, raw: unknown): Promise<Response> {
  const started = Date.now();
  const parsed = SyncRequest.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path, 'sync');
  const { action: _a, wait, ...payload } = parsed.data;

  const { data, error } = await db.rpc('rpc_media_sync', { p_token_hash: keyHash, p: payload });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, action: 'sync', error: error.code }));
    return rpcError(error.code);
  }
  const reply = data as SyncData;

  // Inbox files the speaker no longer needs: delete them after the reply (never slows the speaker).
  const trash = reply.trash ?? [];
  delete (reply as Partial<SyncData>).trash;
  if (trash.length) {
    await later(
      db.storage
        .from('media-inbox')
        .remove(trash)
        .then(async ({ error: e }) => {
          if (e) return console.log(JSON.stringify({ fn: FN_VERSION, trash_error: e.message }));
          const { error: e2 } = await db.rpc('rpc_media_trash_done', { p_token_hash: keyHash, p_paths: trash });
          if (e2) console.log(JSON.stringify({ fn: FN_VERSION, trash_done_error: e2.code }));
        }),
    );
  }

  // Long-poll: nothing to do yet → wait for a command (or a song to collect), up to 25 s.
  let waited = 0;
  if (wait && !reply.commands.length && !reply.downloads.length && !reply.deletions.length) {
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until && !req.signal.aborted) {
      await sleep(POLL_MS);
      const { data: p, error: pe } = await db.rpc('rpc_media_pending', { p_token_hash: keyHash });
      if (pe) break;
      const pending = p as { commands: MediaCommand[]; wake: boolean };
      if (pending.commands.length) {
        reply.commands = pending.commands;
        break;
      }
      if (pending.wake) {
        (reply as Record<string, unknown>).sync_now = true; // a song is waiting: sync again at once
        break;
      }
    }
    waited = Date.now() - started;
  }

  for (const d of reply.downloads) {
    const { data: link } = await db.storage.from('media-inbox').createSignedUrl(d.path, LINK_SECONDS);
    if (link?.signedUrl) d.url = link.signedUrl;
  }

  console.log(
    JSON.stringify({
      fn: FN_VERSION,
      action: 'sync',
      commands: reply.commands.map((c) => c.command),
      downloads: reply.downloads.length,
      deletions: reply.deletions.length,
      trash: trash.length,
      waited,
      ms: Date.now() - started,
    }),
  );
  return json({ ok: true, fn_version: FN_VERSION, ...reply });
}

async function artUpload(db: SupabaseClient, keyHash: string, raw: unknown): Promise<Response> {
  const parsed = ArtUpload.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path, 'art_upload');
  const { data: who, error } = await db.rpc('rpc_media_pair_poll', { p_token_hash: keyHash });
  const me = who as { status: string; device_id?: string } | null;
  if (error || me?.status !== 'paired') return json({ ok: false, error: 'unauthorized' }, 401);
  const sha = parsed.data.sha256.toLowerCase();
  const { data: track } = await db
    .from('media_track')
    .select('household_id, device_id')
    .eq('device_id', me.device_id ?? '')
    .eq('sha256', sha)
    .maybeSingle();
  if (!track) return json({ ok: false, error: 'rejected' }, 400);
  const path = `${track.household_id}/pc-${sha.slice(0, 32)}.webp`;
  const { data: up, error: ue } = await db.storage.from('media-art').createSignedUploadUrl(path, { upsert: true });
  if (ue || !up) return json({ ok: false, error: 'server' }, 500);
  return json({ ok: true, fn_version: FN_VERSION, path, url: up.signedUrl });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION, protocol: PROTOCOL_VERSION });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  try {
    const raw = await readBody(req);
    if (raw instanceof Response) return raw;
    const action = (raw as { action?: unknown } | null)?.action;
    const db = admin();

    if (action === 'pair_start') {
      const parsed = PairStart.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.path, 'pair_start');
      const { data, error } = await db.rpc('rpc_media_pair_start', {
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
      const { data, error } = await db.rpc('rpc_media_pair_poll', { p_token_hash: keyHash });
      if (error) return rpcError(error.code);
      return json({ ok: true, fn_version: FN_VERSION, ...(data as object) });
    }
    if (action === 'sync') return await sync(req, db, keyHash, raw);
    if (action === 'art_upload') return await artUpload(db, keyHash, raw);
    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: e instanceof Error ? e.name : 'unknown' }));
    return json({ ok: false, error: 'server' }, 500);
  }
});
