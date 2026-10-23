// match-agent — matching that runs by itself, AI in shadow (Phase 9b).
//
//   GET                                   → { ok, fn_version, keys: { groq, gemini, openai } } (set or not; never a key)
//   POST + X-Gedara-Cron: <token>         → the twice-daily run from pg_cron (migration 81): one run per household
//   POST + the user's JWT, body:
//     { household_id, mode: 'run' }       → "Check now" (at most once a minute)
//     { household_id, mode: 'eval' }      → one batch of the accuracy test (owner); the page asks again while
//                                           `remaining` > 0
//     { household_id, mode: 'check' }     → one tiny question to every model of the ladder: are the keys right? (owner,
//                                           once a minute, within the monthly cap)
//
// The work is in ../_shared/match/run.ts (rules first, then the AI ladder in ../_shared/ai). The bundle
// the database gives (rpc_match_bundle) never contains an SMS body, and every request to an AI passes the
// guard. Nothing is booked: suggestions wait for a person. verify_jwt is off (pg_cron has no session);
// both POST paths authenticate here; the cron token is checked inside the database.
// Secrets: GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY (scripts/ai-secrets.mjs). Logs: one line per run,
// counts and error codes only — never text, keys or answers. Bump FN_VERSION on every deploy.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'npm:zod@4.6.5';
import { decide } from '../_shared/ai/ladder.ts';
import type { ModelRef, Provider } from '../_shared/ai/providers.ts';
import { KEY_NAMES } from '../_shared/ai/providers.ts';
import { runEval, runMatching, type Bundle, type RunOutput } from '../_shared/match/run.ts';

const FN_VERSION = 'match-agent-4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function keys(): Partial<Record<Provider, string>> {
  const out: Partial<Record<Provider, string>> = {};
  for (const p of Object.keys(KEY_NAMES) as Provider[]) {
    const v = Deno.env.get(KEY_NAMES[p])?.trim();
    if (v && v.length >= 20) out[p] = v;
  }
  return out;
}

const UserBody = z.object({ household_id: z.uuid(), mode: z.enum(['run', 'eval', 'check']) });

function service(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function rpcStatus(code: string | undefined): number {
  if (code === '42501') return 403;
  if (code === 'GDRTE') return 429;
  if (code === '22023' || code === '23514' || code === '22P02') return 400;
  return 500;
}

/** One run for one household: bundle → rules + AI → save. */
async function work(db: SupabaseClient, householdId: string, runId: string, mode: 'run' | 'eval') {
  const { data: bundle, error } = await db.rpc('rpc_match_bundle', { p_household: householdId, p_run: runId, p_mode: mode });
  if (error) throw error;
  const env = { keys: keys() };
  const out: RunOutput & { remaining?: number; total?: number } =
    mode === 'eval' ? await runEval(bundle as Bundle, env) : await runMatching(bundle as Bundle, env);
  const { error: saveErr } = await db.rpc('rpc_match_save', {
    p_household: householdId,
    p_run: runId,
    p: { suggestions: out.suggestions, usage: out.usage, evals: out.evals, stale: out.stale, stats: out.stats },
  });
  if (saveErr) throw saveErr;
  console.log(JSON.stringify({ fn: FN_VERSION, mode, ...out.stats }));
  return out;
}

/** "Are the keys right?": one tiny, harmless question to each model of the ladder. */
async function check(steps: ModelRef[]) {
  const results: Array<{ provider: Provider; model: string; ok: boolean; error: string | null }> = [];
  const usage = [];
  for (const ref of steps) {
    const { decisions, usage: u } = await decide({
      task: 'sms_category',
      items: [{ i: 0, payload: { merchant: 'NETFLIX.COM', amount: 2990, kind: 'card_charge' } }],
      shared: { categories: [{ id: 'C1', name: 'Services › Subscriptions' }, { id: 'C2', name: 'Grocery › Vegetables' }] },
      steps: [ref],
      keys: keys(),
      budget: { allow: () => true, spend: () => undefined },
      labelOk: (a) => a.category === 'C1' || a.category === 'C2',
    });
    usage.push(...u);
    const d = decisions.get(0);
    results.push({
      provider: ref.provider, model: ref.model, ok: !!d?.answer,
      error: d?.answer ? null : u[0]?.error ?? 'no_answer',
    });
  }
  return { results, usage };
}

async function fromCron(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: 'unauthorized' }, 401);
  const db = service();
  const { data: runs, error } = await db.rpc('rpc_match_cron_begin', { p_token: token });
  if (error) {
    console.log(JSON.stringify({ fn: FN_VERSION, path: 'cron', error: error.code }));
    return json({ error: 'unauthorized' }, rpcStatus(error.code));
  }
  let failed = 0;
  for (const r of (runs ?? []) as Array<{ household_id: string; run_id: string }>) {
    try {
      await work(db, r.household_id, r.run_id, 'run');
    } catch (err) {
      failed++;
      console.log(JSON.stringify({ fn: FN_VERSION, path: 'cron', error: (err as { code?: string }).code ?? 'run' }));
    }
  }
  return json({ ok: true, runs: (runs ?? []).length, failed });
}

async function fromUser(req: Request, auth: string) {
  const parsed = UserBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'bad request' }, 400);
  const { household_id: householdId, mode } = parsed.data;
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await user.auth.getUser();
  if (!who.user) return json({ error: 'unauthorized' }, 401);

  // The database decides who may do what, and how often (rpc_match_request).
  const { data: runId, error } = await user.rpc('rpc_match_request', {
    p_household: householdId,
    p_trigger: mode === 'run' ? 'user' : mode, // 'run' is "Check now" ('user'); 'eval' and 'check' are the owner's
  });
  if (error) return json({ error: error.code === 'GDRTE' ? 'too often' : 'not allowed' }, rpcStatus(error.code));
  const db = service();
  try {
    if (mode === 'check') {
      const { data: setting } = await db.from('match_setting').select('steps, monthly_cap_usd').eq('household_id', householdId).maybeSingle();
      // the key test costs a fraction of a cent, but it still respects the owner's monthly cap
      const { data: spent } = await db.from('v_ai_cost_month').select('cost_usd').eq('household_id', householdId)
        .eq('month', new Date().toISOString().slice(0, 7) + '-01');
      const monthCost = (spent ?? []).reduce((a, r) => a + Number(r.cost_usd), 0);
      if (monthCost >= Number(setting?.monthly_cap_usd ?? 3)) {
        await db.rpc('rpc_match_save', { p_household: householdId, p_run: runId, p: { stats: { check: true, capped: true } } });
        return json({ error: 'monthly cap reached' }, 429);
      }
      const steps = ((setting?.steps as ModelRef[] | undefined) ?? []).length
        ? (setting!.steps as ModelRef[])
        : [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'gemini', model: 'gemini-3.8-flash' }, { provider: 'openai', model: 'gpt-5.4-mini' }] as ModelRef[];
      const { results, usage } = await check(steps);
      const { error: saveErr } = await db.rpc('rpc_match_save', { p_household: householdId, p_run: runId, p: { usage, stats: { check: true } } });
      if (saveErr) throw saveErr;
      console.log(JSON.stringify({ fn: FN_VERSION, mode, ok: results.filter((r) => r.ok).length, of: results.length }));
      return json({ ok: true, results });
    }
    const out = await work(db, householdId, runId as string, mode);
    return json({ ok: true, stats: out.stats, remaining: out.remaining ?? null, total: out.total ?? null });
  } catch (err) {
    console.log(JSON.stringify({ fn: FN_VERSION, mode, error: (err as { code?: string }).code ?? 'run' }));
    return json({ error: 'failed' }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    const k = keys();
    return json({ ok: true, fn_version: FN_VERSION, keys: { groq: !!k.groq, gemini: !!k.gemini, openai: !!k.openai } });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const cron = req.headers.get('x-gedara-cron');
  if (cron) return fromCron(cron);
  const auth = req.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return fromUser(req, auth);
  return json({ error: 'unauthorized' }, 401);
});
