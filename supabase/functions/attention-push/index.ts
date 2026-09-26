// attention-push — the daily Attention notification (Phase 6, MASTER_PLAN §4 row 7).
//
//   GET                           → { ok, fn_version, vapid_public_key } (the browser's applicationServerKey;
//                                   the web app gets it here, so no VAPID value lives in apps/web)
//   POST + X-Gedara-Cron: <token> → the daily run from pg_cron (migration 49): rpc_push_digest claims
//                                   today's run per household, we send one summary per device, then
//                                   rpc_push_result records it (404/410 devices are removed)
//   POST + the user's JWT, {test:true} → a test message to the caller's OWN devices only
//
// verify_jwt is off (pg_cron has no user session); both POST paths authenticate here. The cron
// token is checked inside the database (Vault), never compared or logged here.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Bump FN_VERSION on every deploy.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'npm:zod@4.6.5';
import { type DigestItem, digestMessage } from '../_shared/push/digest.ts';
import { type PushResult, type VapidKeys, sendPush } from '../_shared/push/webpush.ts';

const FN_VERSION = 'attention-push-2';

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

function vapidKeys(): VapidKeys | null {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
  const subject = Deno.env.get('VAPID_SUBJECT') ?? '';
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^(mailto:|https:)/.test(subject)) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

const Sub = z.object({
  id: z.uuid(),
  endpoint: z.url().startsWith('https://').max(1000),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
});

const Item = z.object({
  kind: z.string().max(40),
  severity: z.string().max(10),
  title: z.string().max(200).nullable(),
  days_left: z.number().int().nullable(),
  qty: z.union([z.number(), z.string()]).nullable(),
  amount: z.union([z.number(), z.string()]).nullable().optional(),
});

const Digest = z.object({
  runs: z
    .array(
      z.object({
        run_id: z.uuid(),
        household_id: z.uuid(),
        total: z.number().int().nonnegative(),
        items: z.array(Item).max(5),
        subscriptions: z.array(Sub).max(50),
      }),
    )
    .max(100),
});

const TestBody = z.object({ test: z.literal(true), subscription_id: z.uuid().optional() });

/** Send to a few devices at a time. */
async function sendAll<T extends z.infer<typeof Sub>>(subs: T[], message: unknown, vapid: VapidKeys, urgency: 'normal' | 'high') {
  const results: (PushResult & { id: string })[] = [];
  for (let i = 0; i < subs.length; i += 6) {
    const batch = subs.slice(i, i + 6);
    const done = await Promise.all(batch.map((s) => sendPush(s, message, vapid, { urgency, topic: 'attention' })));
    done.forEach((r, j) => results.push({ ...r, id: batch[j].id }));
  }
  return results;
}

// ── Daily run (pg_cron) ───────────────────────────────────────────────────────
async function daily(token: string, vapid: VapidKeys): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, error: 'unauthorized' }, 401);
  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('rpc_push_digest', { p_token: token });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, path: 'daily', error: error.code }));
    return json({ ok: false, error: error.code === '42501' ? 'unauthorized' : 'failed' }, error.code === '42501' ? 401 : 500);
  }
  const parsed = Digest.safeParse(data);
  if (!parsed.success) {
    console.log(JSON.stringify({ fn: FN_VERSION, path: 'daily', error: 'digest_shape' }));
    return json({ ok: false, error: 'failed' }, 500);
  }

  let sent = 0;
  let failed = 0;
  for (const run of parsed.data.runs) {
    const message = digestMessage(run.total, run.items as DigestItem[]);
    const urgent = run.items.some((i) => i.severity === 'red');
    const results = await sendAll(run.subscriptions, message, vapid, urgent ? 'high' : 'normal');
    sent += results.filter((r) => r.ok).length;
    failed += results.filter((r) => !r.ok).length;
    const { error: resErr } = await admin.rpc('rpc_push_result', {
      p_token: token,
      p_run: run.run_id,
      p_results: results.map((r) => ({ id: r.id, ok: r.ok, status: r.status, error: r.error ?? null })),
    });
    if (resErr) console.log(JSON.stringify({ fn: FN_VERSION, path: 'daily', result_error: resErr.code }));
  }
  console.log(JSON.stringify({ fn: FN_VERSION, path: 'daily', runs: parsed.data.runs.length, sent, failed }));
  return json({ ok: true, fn_version: FN_VERSION, runs: parsed.data.runs.length, sent, failed });
}

// ── Test message to my own devices ────────────────────────────────────────────
async function test(req: Request, authHeader: string, vapid: VapidKeys): Promise<Response> {
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return json({ ok: false, error: 'unauthorized' }, 401);

  let raw: unknown;
  try {
    raw = JSON.parse((await req.text()).slice(0, 2000));
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const body = TestBody.safeParse(raw);
  if (!body.success) return json({ ok: false, error: 'invalid' }, 400);

  // RLS: only the caller's own rows come back.
  let q = supabase.from('push_subscription').select('id, endpoint, p256dh, auth').eq('enabled', true);
  if (body.data.subscription_id) q = q.eq('id', body.data.subscription_id);
  const { data: rows, error } = await q.limit(20);
  if (error) return json({ ok: false, error: 'failed' }, 500);
  const subs = z.array(Sub).safeParse(rows);
  if (!subs.success) return json({ ok: false, error: 'failed' }, 500);

  const message = {
    title: 'Gedara notifications work',
    body: 'Each morning at 7:00 you get one summary of what needs attention.',
    url: '/attention',
    tag: 'gedara-test',
    count: 0,
  };
  const results = await sendAll(subs.data, message, vapid, 'normal');
  for (const r of results) {
    if (r.ok) {
      await supabase.from('push_subscription').update({ last_ok_at: new Date().toISOString(), last_error: null, fail_count: 0 }).eq('id', r.id);
    } else if (r.status === 404 || r.status === 410) {
      await supabase.from('push_subscription').delete().eq('id', r.id);
    } else {
      await supabase.from('push_subscription').update({ last_error: (r.error ?? 'failed').slice(0, 300) }).eq('id', r.id);
    }
  }
  const sent = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ fn: FN_VERSION, path: 'test', sent, failed: results.length - sent }));
  return json({
    ok: true,
    fn_version: FN_VERSION,
    sent,
    failed: results.length - sent,
    results: results.map((r) => ({ id: r.id, ok: r.ok, status: r.status })),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const vapid = vapidKeys();
  if (req.method === 'GET') {
    return json({ ok: true, fn_version: FN_VERSION, vapid_public_key: vapid?.publicKey ?? null });
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!vapid) return json({ ok: false, error: 'not_configured', fn_version: FN_VERSION }, 503);

  const cron = req.headers.get('X-Gedara-Cron');
  if (cron !== null) return await daily(cron, vapid);
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'unauthorized' }, 401);
  return await test(req, authHeader, vapid);
});
