// sms-ingest — bank / card SMS alerts into the review inbox (Phase 2b).
//
// Two callers, one parser (../_shared/sms/parse.ts):
//   • The Android "SMS to URL Forwarder" app: header `X-Gedara-Device: <token>`, body
//     {"from","text","receivedStamp","sentStamp"} — one SMS per request. The token's sha256 finds the
//     device (and its household) in rpc_sms_ingest_device, the only RPC called with the service role.
//   • The web app's SMS-backup import: the signed-in user's JWT, body {household_id, messages[]} —
//     stored with rpc_sms_import under the user's own rights (can_write).
// verify_jwt is off (the phone has no Supabase session); this handler authenticates both paths itself.
// Filtered texts (OTP, promo, unknown sender) are counted, never stored; replies and logs never
// contain message text. Bump FN_VERSION on every deploy of this function.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'npm:zod@4.6.5';
import { type DropReason, type ParsedSms, parseSms } from '../_shared/sms/parse.ts';

const FN_VERSION = 'sms-ingest-1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const DEVICE_MAX_BYTES = 4096;
const IMPORT_MAX_BYTES = 400_000;

const Stamp = z.union([z.number().int().positive(), z.string().regex(/^\d{10,13}$/)]);

const ForwardedSms = z.object({
  from: z.string().trim().min(1).max(60),
  text: z.string().min(1).max(2000),
  receivedStamp: Stamp.optional(),
  sentStamp: Stamp.optional(),
});

const BackupBatch = z.object({
  household_id: z.uuid(),
  messages: z
    .array(
      z.object({
        sender: z.string().trim().min(1).max(60),
        body: z.string().min(1).max(2000),
        receivedAt: z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]),
      }),
    )
    .min(1)
    .max(200),
});

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

/** Epoch ms as number or string (the forwarder's placeholders) → ms. */
function stampMs(s: number | string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  // Seconds vs milliseconds: anything before 2001 in ms is really seconds.
  return n < 1e12 ? n * 1000 : n;
}

async function readBody(req: Request, max: number): Promise<unknown | Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) return json({ ok: false, error: 'too_large' }, 413);
  const text = await req.text();
  if (text.length > max) return json({ ok: false, error: 'too_large' }, 413);
  try {
    return JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
}

function rpcStatus(code: string | undefined): number {
  if (code === '42501') return 401;
  if (code === 'GDRTE') return 429;
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') return 400;
  return 500;
}

// ── Device path ───────────────────────────────────────────────────────────────
async function fromDevice(req: Request, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ ok: false, error: 'unauthorized' }, 401);
  const raw = await readBody(req, DEVICE_MAX_BYTES);
  if (raw instanceof Response) return raw;
  const parsed = ForwardedSms.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: 'invalid' }, 400);

  const { from, text, receivedStamp, sentStamp } = parsed.data;
  const receivedAt = stampMs(receivedStamp) ?? stampMs(sentStamp) ?? Date.now();
  const verdict = parseSms({ sender: from, body: text, receivedAt });

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('rpc_sms_ingest_device', {
    p_token_hash: await sha256Hex(token),
    p_messages: verdict.keep ? [verdict.sms] : [],
    p_dropped: verdict.keep ? 0 : 1,
    p_rejected_sender: !verdict.keep && verdict.reason === 'sender' ? from.slice(0, 40) : null,
  });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, path: 'device', error: error.code }));
    return json({ ok: false, error: error.code === '42501' ? 'unauthorized' : 'rejected' }, rpcStatus(error.code));
  }
  const result = { ok: true, fn_version: FN_VERSION, ...(data as object), filtered: verdict.keep ? null : verdict.reason };
  console.log(JSON.stringify({ fn: FN_VERSION, path: 'device', ...(data as object), filtered: result.filtered }));
  return json(result);
}

// ── SMS-backup path (signed-in user) ──────────────────────────────────────────
async function fromUser(req: Request, authHeader: string): Promise<Response> {
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return json({ ok: false, error: 'unauthorized' }, 401);

  const raw = await readBody(req, IMPORT_MAX_BYTES);
  if (raw instanceof Response) return raw;
  const parsed = BackupBatch.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: 'invalid' }, 400);

  const keep: ParsedSms[] = [];
  const filtered: Record<DropReason, number> = { sender: 0, otp: 0, promo: 0, no_amount: 0, invalid: 0 };
  for (const m of parsed.data.messages) {
    const v = parseSms({ sender: m.sender, body: m.body, receivedAt: m.receivedAt });
    if (v.keep) keep.push(v.sms);
    else filtered[v.reason]++;
  }

  let stored = { stored: 0, duplicate: 0, dropped: 0 };
  if (keep.length) {
    const { data, error } = await supabase.rpc('rpc_sms_import', {
      p_household: parsed.data.household_id,
      p_messages: keep,
    });
    if (error) {
      console.log(JSON.stringify({ fn: FN_VERSION, path: 'backup', error: error.code }));
      return json({ ok: false, error: error.code === '42501' ? 'forbidden' : 'rejected' }, error.code === '42501' ? 403 : rpcStatus(error.code));
    }
    stored = data as typeof stored;
  }
  const result = { ok: true, fn_version: FN_VERSION, ...stored, filtered };
  console.log(JSON.stringify({ fn: FN_VERSION, path: 'backup', ...stored, filtered }));
  return json(result);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  try {
    const device = req.headers.get('x-gedara-device');
    if (device) return await fromDevice(req, device.trim());
    const auth = req.headers.get('authorization') ?? '';
    if (/^Bearer\s+\S+/i.test(auth)) return await fromUser(req, auth);
    return json({ ok: false, error: 'unauthorized' }, 401);
  } catch (e) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: e instanceof Error ? e.name : 'unknown' }));
    return json({ ok: false, error: 'server' }, 500);
  }
});
