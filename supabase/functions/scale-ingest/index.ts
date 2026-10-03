// scale-ingest — the kitchen scale's one endpoint (Phase 6b, docs/kitchen-scale/protocol.md).
//
// Caller: the ESP32-S3 scale, header `X-Gedara-Device: <token>` (43 characters, shown once when the
// scale was added in Settings › Devices). The token's sha256 finds the device and its household in
// rpc_scale_sync — the only RPC called with the service role — which applies the readings (stock only
// moves through stock_movement, rule 1), records status and returns commands/config. verify_jwt is
// off (the scale has no Supabase session and holds no Supabase key of any kind). Firmware links for
// an `ota` command are signed here for 10 minutes. Payloads are Zod-validated (rule 6); logs and
// replies never contain the token. Bump FN_VERSION on every deploy of this function.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { PROTOCOL_VERSION, SyncRequest } from '../_shared/scale/protocol.ts';

const FN_VERSION = 'scale-ingest-1';
const MAX_BYTES = 16_384;
const FIRMWARE_LINK_SECONDS = 600;

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

type Command = { id: string; command: string; args: Record<string, unknown> };

async function sync(req: Request, token: string): Promise<Response> {
  const started = Date.now();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ ok: false, error: 'unauthorized' }, 401);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const parsed = SyncRequest.safeParse(raw);
  if (!parsed.success) {
    // Which field, never its value — enough for Diagnostics, nothing private.
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    console.log(JSON.stringify({ fn: FN_VERSION, error: 'invalid', path }));
    return json({ ok: false, error: 'invalid', path }, 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('rpc_scale_sync', {
    p_token_hash: await sha256Hex(token),
    p: parsed.data,
  });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: error.code }));
    const status = rpcStatus(error.code);
    return json({ ok: false, error: status === 401 ? 'unauthorized' : status === 429 ? 'slow_down' : 'rejected' }, status);
  }

  const reply = data as { commands: Command[]; results: { status: string }[] } & Record<string, unknown>;
  // An update: swap the storage path for a short-lived signed link.
  for (const c of reply.commands) {
    if (c.command !== 'ota') continue;
    const path = typeof c.args.path === 'string' ? c.args.path : '';
    delete c.args.path;
    if (!path) continue;
    const { data: link } = await admin.storage.from('device-firmware').createSignedUrl(path, FIRMWARE_LINK_SECONDS);
    if (link?.signedUrl) c.args.url = link.signedUrl;
  }

  const statuses: Record<string, number> = {};
  for (const r of reply.results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  console.log(
    JSON.stringify({
      fn: FN_VERSION,
      events: parsed.data.events.length,
      statuses,
      commands: reply.commands.length,
      ms: Date.now() - started,
    }),
  );
  return json({ ok: true, fn_version: FN_VERSION, ...reply });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION, protocol: PROTOCOL_VERSION });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  try {
    const device = req.headers.get('x-gedara-device');
    if (device) return await sync(req, device.trim());
    return json({ ok: false, error: 'unauthorized' }, 401);
  } catch (e) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: e instanceof Error ? e.name : 'unknown' }));
    return json({ ok: false, error: 'server' }, 500);
  }
});
