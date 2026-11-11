// scanner-ingest — the bin scanner's one endpoint (Phase 11, docs/bin-scanner/protocol.md).
//
// Caller: the ESP32 scanner by the kitchen bin, header `X-Gedara-Device: <key>` (43 characters, shown
// once when the scanner was added in Settings › Devices). The key's sha256 finds the scanner and its
// household in rpc_scanner_sync — the only RPC called, with the service role — which applies the
// scans (stock only moves through stock_movement, rule 1), enforces the limits and returns results,
// commands, settings and the names list. The household never comes from the request. verify_jwt is
// off (the scanner has no Supabase session and holds no Supabase key of any kind).
//
// Log budget (Log Ingestion is Gedara's tightest quota): the scanner calls once per scan or small
// batch and for a heartbeat every 30 minutes, never in a loop; the RPC goes straight to Postgres
// (_shared/db/direct.ts), which the API gateway doesn't log; only errors and pauses are logged here.
// Firmware links for an `ota` command are signed here for 10 minutes. When a limit pauses the
// scanner, the owner's phones are told at once by Web Push (the morning summary's keys); those
// alerts are never passed on to the scanner. Payloads are Zod-validated (rule 6); logs and replies
// never contain the key or a scanned code. Bump FN_VERSION on every deploy of this function.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';
import { dbCheck, rpc } from '../_shared/db/direct.ts';
import { corsHeaders, json, readBody, rpcError, sha256Hex } from '../_shared/device/http.ts';
import { sendPush, type VapidKeys } from '../_shared/push/webpush.ts';
import { PROTOCOL_VERSION, SyncRequest } from '../_shared/scanner/protocol.ts';

const FN_VERSION = 'scanner-ingest-1';
const MAX_BYTES = 16_384;
const FIRMWARE_LINK_SECONDS = 600;

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

interface Alert {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  title: string;
  body: string;
  tag: string;
  url: string;
}
type Command = { id: string; command: string; args: Record<string, unknown> };

function vapidKeys(): VapidKeys | null {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
  const subject = Deno.env.get('VAPID_SUBJECT') ?? '';
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^(mailto:|https:)/.test(subject)) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

/** "The scanner was paused": to each of the owner's phones, at once. */
async function sendAlerts(db: SupabaseClient, alerts: Alert[]): Promise<void> {
  const vapid = vapidKeys();
  if (!vapid) {
    console.log(JSON.stringify({ fn: FN_VERSION, action: 'alert', error: 'no_vapid_keys' }));
    return;
  }
  let sent = 0;
  for (const a of alerts.slice(0, 20)) {
    if (!a.endpoint.startsWith('https://')) continue;
    const r = await sendPush(a, { title: a.title, body: a.body, tag: a.tag, url: a.url }, vapid, {
      urgency: 'high',
      ttl: 3600,
      topic: a.tag.slice(-32).replace(/[^A-Za-z0-9_-]/g, ''),
    });
    if (r.ok) {
      sent++;
      await db.from('push_subscription').update({ last_ok_at: new Date().toISOString(), last_error: null, fail_count: 0 }).eq('id', a.subscription_id);
    } else if (r.status === 404 || r.status === 410) {
      await db.from('push_subscription').delete().eq('id', a.subscription_id);
    } else {
      await db.from('push_subscription').update({ last_error: (r.error ?? 'failed').slice(0, 300) }).eq('id', a.subscription_id);
    }
  }
  console.log(JSON.stringify({ fn: FN_VERSION, action: 'alert', alerts: alerts.length, sent }));
}

async function sync(req: Request, key: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return json({ ok: false, error: 'unauthorized' }, 401);

  const raw = await readBody(req, MAX_BYTES);
  if (raw instanceof Response) return raw;
  const parsed = SyncRequest.safeParse(raw);
  if (!parsed.success) {
    // Which field, never its value — enough for Diagnostics, nothing private.
    const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    console.log(JSON.stringify({ fn: FN_VERSION, error: 'invalid', path }));
    return json({ ok: false, error: 'invalid', path }, 400);
  }

  const db = admin();
  const { data, error } = await rpc(db, 'rpc_scanner_sync', {
    p_token_hash: { value: await sha256Hex(key), type: 'text' },
    p: { value: parsed.data, type: 'jsonb' },
  });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: error.code }));
    return rpcError(error.code);
  }

  const { alerts, device: _device, paused_now, ...reply } = data as {
    alerts?: Alert[];
    device?: unknown;
    paused_now?: boolean;
    commands: Command[];
    results: { status: string }[];
  } & Record<string, unknown>;

  // An update: swap the storage path for a short-lived signed link.
  for (const c of reply.commands ?? []) {
    if (c.command !== 'ota') continue;
    const path = typeof c.args.path === 'string' ? c.args.path : '';
    delete c.args.path;
    if (!path) continue;
    const { data: link } = await db.storage.from('device-firmware').createSignedUrl(path, FIRMWARE_LINK_SECONDS);
    if (link?.signedUrl) c.args.url = link.signedUrl;
  }

  if (paused_now) console.log(JSON.stringify({ fn: FN_VERSION, action: 'paused', reason: reply.paused_reason ?? null }));
  if (reply.results.some((r) => r.status === 'error')) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: 'event', count: reply.results.filter((r) => r.status === 'error').length }));
  }
  if (Array.isArray(alerts) && alerts.length) await later(sendAlerts(db, alerts));
  return json({ ok: true, fn_version: FN_VERSION, ...reply });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION, protocol: PROTOCOL_VERSION, db: await dbCheck() });
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
