// Ask Gedara accuracy run (Phase 10). Two steps, and no household data ever reaches an AI:
//   1. plans  — every question of tests/ask/questions.json goes to the STAGING ask-gedara function (the AI sees the
//               question only) with the e2e session (playwright/.auth/user.json, from `npx playwright test --project=setup`);
//   2. numbers — the plans run READ-ONLY on a project (default prod) inside one transaction that always rolls back:
//               the pending migrations are applied first (so the ask_* functions exist), the calls run as the
//               household's owner (RLS), the hand-written truth SQL runs alongside, and the results come back in a
//               raised error (the same trick as scripts/sql-test.mjs), so nothing is ever committed.
// Writes docs/ask-accuracy.md (no amounts) and, git-ignored, playwright/.auth/ask-accuracy-detail.md + ask-eval.json.
//
// Usage: node scripts/ask-eval.mts [prod|staging] [--reuse-plans]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local', quiet: true });

const REFS: Record<string, string> = { staging: 'ebtvpsrehwdxepayqwma', prod: 'ltzlsxupcsamwtgqfejg' };
const target = process.argv.find((a) => a === 'prod' || a === 'staging') ?? 'prod';
const reuse = process.argv.includes('--reuse-plans');
// staging only: forget today's Ask usage of the e2e user, so a re-run isn't stopped by the daily limit
const resetQuota = process.argv.includes('--reset-quota');
const OUT = 'playwright/.auth/ask-eval.json';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

interface Question { id: string; lang: string; q: string; pick?: string; truth?: string; same?: string; refusal?: string; set?: string }
interface Call { tool: string; args: Record<string, unknown> }
interface Plan { calls: Call[]; refusal: string | null }
interface Asked { id: string; status: number; plan?: Plan; provider?: string; model?: string; error?: string; today?: string }

const set = JSON.parse(readFileSync('tests/ask/questions.json', 'utf8')) as { spend: string; questions: Question[] };
const byId = new Map(set.questions.map((q) => [q.id, q]));
const truthOf = (q: Question) => (q.same ? byId.get(q.same)!.truth : q.truth)?.replace('{spend}', set.spend);

// ── 1. Plans from the staging function ─────────────────────────────────────────
async function plans(): Promise<Asked[]> {
  const url = process.env.VITE_SUPABASE_URL!;
  if (!url.includes(REFS.staging)) throw new Error('VITE_SUPABASE_URL is not staging');
  const state = JSON.parse(readFileSync('playwright/.auth/user.json', 'utf8')) as { origins: Array<{ localStorage: Array<{ name: string; value: string }> }> };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const jwt = (JSON.parse(item!.value) as { access_token: string }).access_token;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: hh } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  const household = hh!.id as string;
  const { data: before } = await admin.from('match_setting').select('ask_enabled, ask_daily_per_person').eq('household_id', household).maybeSingle();
  await admin.from('match_setting').upsert({ household_id: household, ask_enabled: true, ask_daily_per_person: 100 } as never);
  if (resetQuota) {
    const { data: who } = await admin.auth.getUser(jwt);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await admin.from('ai_usage').delete().eq('household_id', household).eq('task', 'ask').eq('user_id', who.user!.id).gte('at', since);
    if (r.error) throw r.error;
  }
  const out: Asked[] = [];
  try {
    for (const q of set.questions) {
      const send = () =>
        fetch(`${url}/functions/v1/ask-gedara`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, apikey: process.env.VITE_SUPABASE_ANON_KEY!, 'Content-Type': 'application/json' },
          body: JSON.stringify({ household_id: household, request_id: crypto.randomUUID(), question: q.q }),
        });
      let res = await send();
      // the platform's own 502/503/504 (no reply from the function): once more, as the app does
      if ([502, 503, 504].includes(res.status) && !(res.headers.get('content-type') ?? '').includes('json')) res = await send();
      const body = (await res.json().catch(() => ({}))) as { plan?: Plan; provider?: string; model?: string; error?: string; today?: string };
      out.push({ id: q.id, status: res.status, ...body });
      process.stdout.write(res.ok ? '.' : `[${q.id}:${res.status} ${body.error}]`);
      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally {
    if (before) await admin.from('match_setting').update(before as never).eq('household_id', household);
  }
  console.log();
  return out;
}

// ── 2. Numbers, read-only, always rolled back ──────────────────────────────────
const lit = (k: string, v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  const s = `'${String(v).replace(/'/g, "''")}'`;
  if (k === 'p_from' || k === 'p_to' || k === 'p_month') return `${s}::date`;
  if (k === 'p_id') return `${s}::uuid`;
  return `${s}::text`;
};
const TOOLS = new Set(['ask_spend', 'ask_transactions', 'ask_due', 'ask_instalments', 'ask_find', 'ask_pantry', 'ask_balances', 'ask_budget', 'ask_warranty']);

function appliedOn(ref: string): Set<string> {
  const q = path.join(mkdtempSync(path.join(tmpdir(), 'gedara-askq-')), 'applied.sql');
  writeFileSync(q, 'select version from supabase_migrations.schema_migrations');
  const out = execFileSync(npx, ['--yes', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', ref, '-f', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell });
  return new Set([...out.matchAll(/"version":\s*"(\d+)"/g)].map((m) => m[1]!));
}

function numbers(asked: Asked[], today: string): Record<string, { got: unknown; truth: string | null; error?: string }> {
  const ref = REFS[target]!;
  const applied = appliedOn(ref);
  const pending = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql') && !applied.has(f.split('_')[0]!)).sort();
  console.log(`${target}: pending migrations applied inside the rolled-back transaction: ${pending.join(', ') || '(none)'}`);
  const migrations = pending.map((f) => readFileSync(path.join('supabase/migrations', f), 'utf8')).join('\n;\n');
  const T = `'${today}'::date`;
  const H = '(select id from _h)';
  const lines: string[] = [
    'begin;',
    migrations,
    ';',
    'create temp table _h on commit drop as select id from public.household order by created_at limit 1;',
    'create temp table _ask (id text primary key, got jsonb, truth text, error text) on commit drop;',
    'grant all on _h, _ask to public;',
    "select set_config('request.jwt.claims', json_build_object('sub', (select m.user_id from public.household_member m where m.household_id = (select id from _h) and m.role = 'owner' limit 1), 'role', 'authenticated')::text, true);",
    'set local role authenticated;',
  ];
  for (const a of asked) {
    const q = byId.get(a.id)!;
    if (q.refusal || !a.plan?.calls.length) continue;
    const results = a.plan.calls
      .filter((c) => TOOLS.has(c.tool))
      .map((c) => `public.${c.tool}(p_household => ${H}${Object.entries(c.args).map(([k, v]) => `, ${k} => ${lit(k, v)}`).join('')})`);
    lines.push(`do $ask$ begin insert into _ask (id, got) select '${a.id}', jsonb_build_array(${results.join(', ')}); exception when others then insert into _ask (id, error) values ('${a.id}', sqlstate || ' ' || sqlerrm); end $ask$;`);
  }
  lines.push('reset role;');
  for (const q of set.questions) {
    const truth = truthOf(q);
    if (!truth) continue;
    const sql = truth.replaceAll(':T', T).replaceAll(':H', H);
    lines.push(`insert into _ask (id) values ('${q.id}') on conflict do nothing;`);
    lines.push(`do $ask$ begin update _ask set truth = (${sql})::text where id = '${q.id}'; exception when others then update _ask set error = coalesce(error || ' / ', '') || 'truth: ' || sqlerrm where id = '${q.id}'; end $ask$;`);
  }
  lines.push(`do $ask$ begin raise exception 'GEDARA_ASK%GEDARA_ASK', (select jsonb_object_agg(id, jsonb_build_object('got', got, 'truth', truth, 'error', error))::text from _ask); end $ask$;`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gedara-askeval-')), 'eval.sql');
  writeFileSync(file, lines.join('\n'));
  let output = '';
  try {
    output = execFileSync(npx, ['--yes', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', ref, '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const flat = output.replace(/\\\\"/g, '"').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const m = /GEDARA_ASK([\s\S]*?)GEDARA_ASK/.exec(flat);
  if (!m) throw new Error(`no results: ${output.slice(-600)}`);
  return JSON.parse(m[1]!);
}

// ── 3. Compare and report ──────────────────────────────────────────────────────
function pick(v: unknown, p: string): unknown {
  let cur = v;
  for (const k of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (k === 'length' && Array.isArray(cur)) return cur.length;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
const same = (a: unknown, b: string | null) => {
  if (a === undefined || a === null) return b === null || b === '';
  if (b === null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && b.trim() !== '') return Math.abs(na - nb) < 0.005;
  return String(a) === b;
};

const asked: Asked[] = reuse && existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as { asked: Asked[] }).asked : await plans();
const today = asked.find((a) => a.today)?.today;
if (!today) throw new Error(`no plan came back: ${JSON.stringify(asked.slice(0, 3))}`);
const res = numbers(asked, today);
writeFileSync(OUT, JSON.stringify({ today, target, asked, res }, null, 2));

const rows: string[] = [];
let right = 0;
let siRight = 0;
let siTotal = 0;
let heldRight = 0;
let heldTotal = 0;
const fails: string[] = [];
for (const q of set.questions) {
  const a = asked.find((x) => x.id === q.id)!;
  let ok: boolean;
  let got: unknown;
  let truth: string | null = null;
  if (q.refusal) {
    got = a.plan?.refusal ?? a.error ?? '—';
    truth = q.refusal;
    ok = a.plan?.refusal === q.refusal && !a.plan.calls.length;
  } else {
    const r = res[q.id];
    truth = r?.truth ?? null;
    got = pick((r?.got as unknown[] | undefined)?.[0], q.pick!);
    ok = !!a.plan && !a.plan.refusal && !r?.error && same(got, truth);
  }
  if (ok) right++;
  if (q.set === 'held') {
    heldTotal++;
    if (ok) heldRight++;
  }
  if (q.lang === 'si') {
    siTotal++;
    if (ok) siRight++;
  }
  const plan = a.plan ? (a.plan.refusal ? `refusal ${a.plan.refusal}` : a.plan.calls.map((c) => `${c.tool}(${Object.entries(c.args).filter(([, v]) => v !== null).map(([k, v]) => `${k.slice(2)}=${v}`).join(', ')})`).join(' + ')) : `error ${a.status} ${a.error}`;
  rows.push(`| ${ok ? '✓' : '✗'} | ${q.set === 'held' ? `${q.id} (held-out)` : q.id} | ${q.q.replace(/\|/g, '/')} | ${plan.replace(/\|/g, '/')} | ${String(got ?? '—')} | ${truth ?? '—'} | ${a.provider ?? '—'} |`);
  if (!ok) fails.push(q.id + (res[q.id]?.error ? ` (${res[q.id]!.error})` : ''));
}
const total = set.questions.length;
const report = [
  '# Ask Gedara — accuracy',
  '',
  `Run ${new Date().toISOString().slice(0, 16)} UTC · today ${today} · numbers on **${target}** (read-only, rolled back) · plans from the staging function.`,
  '',
  `**${right} of ${total} right (${Math.round((right / total) * 100)} %)** · Sinhala ${siRight} of ${siTotal} · held-out (never tuned on) ${heldRight} of ${heldTotal}.`,
  'Release bar: ≥ 95 % right, ≥ 7 of 8 in Sinhala, every refusal correct.',
  '',
  '"Right" = the plan reads the question the way the hand-written truth does AND the number on screen equals the truth.',
  '',
  '| | id | question | plan | answer | truth | model |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  fails.length ? `Not right: ${fails.join(', ')}` : 'All right.',
  '',
].join('\n');
// The full table holds real amounts and names: it stays out of git. docs/ gets the same without them.
writeFileSync('playwright/.auth/ask-accuracy-detail.md', report);
const NL = '\n';
const publicReport = report
  .replace('| | id | question | plan | answer | truth | model |', '| | id | question | plan | model |')
  .replace('|---|---|---|---|---|---|---|', '|---|---|---|---|---|')
  .split(NL)
  .map((l) => (/^\| [✓✗] \|/.test(l) ? l.split(' | ').filter((_, i) => i !== 4 && i !== 5).join(' | ') : l))
  .join(NL);
writeFileSync('docs/ask-accuracy.md', `${publicReport}${NL}Answers and truths (real amounts) are in playwright/.auth/ask-accuracy-detail.md on the PC only.${NL}`);
console.log(`${right}/${total} right · Sinhala ${siRight}/${siTotal} · held-out ${heldRight}/${heldTotal}${fails.length ? ` · not right: ${fails.join(', ')}` : ''}`);
