// Ask Gedara, part 5: one question in, one plan out (Phase 10). Pure: everything from outside (env, the
// asker's own database client, the model call, the clock, the log) comes in through `deps`, so the tests
// can run it without Deno, keys or a network. The order matters:
//   kill switch → method → origin → size → login → question check → rpc_ask_begin (member, switch, limits,
//   cap) → model(s) → Zod → rpc_ask_record (counts only) → the plan.
// The database is only ever touched with the asker's login (never the service role), and only through
// rpc_ask_begin / rpc_ask_record: this function never reads the household's data. The browser runs the plan.
// One log line per request, counts and codes only — never the question, the plan or a number.
import { z } from 'zod';
import type { CallInput, CallResult, ModelRef, Provider } from '../ai/providers.ts';
import { readBody } from '../device/http.ts';
import { corsFor, originAllowed } from './cors.ts';
import { assertAskUser, buildUser, questionCheck, UnsafeAsk } from './guard.ts';
import { PLAN_SCHEMA, toPlan, type AskPlan } from './plan.ts';
import { ASK_SYSTEM } from './prompt.ts';

export const FN_VERSION = 'ask-gedara-3';
export const MAX_BODY = 2048;
const MODEL_TIMEOUT_MS = 20_000;
const ASK_PROVIDERS = ['groq', 'openai'] as const;

interface RpcResult {
  data: unknown;
  error: { code?: string } | null;
}
export interface AskDb {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> };
  rpc(name: 'rpc_ask_begin' | 'rpc_ask_record', args: Record<string, unknown>): PromiseLike<RpcResult>;
}
export interface AskDeps {
  env(name: string): string | undefined;
  /** a client that acts as the person whose Authorization header this is */
  userDb(authorization: string): AskDb;
  callModel(ref: ModelRef, input: CallInput, keys: Partial<Record<Provider, string>>, timeoutMs: number): Promise<CallResult>;
  now(): number;
  log(line: string): void;
}

const Body = z.object({ household_id: z.uuid(), request_id: z.uuid(), question: z.string().max(1000) }).strict();
const Begin = z.object({
  steps: z.array(z.object({ provider: z.enum(ASK_PROVIDERS), model: z.string() })).min(1).max(3),
  today: z.iso.date(),
  used: z.number().int(),
  limit: z.number().int(),
  /** one-time secret for rpc_ask_record (migration 102); never sent to the browser */
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface AskReply {
  plan: AskPlan;
  provider: Provider;
  model: string;
  used: number;
  limit: number;
  today: string;
}

const KEY_NAMES: Record<(typeof ASK_PROVIDERS)[number], string> = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY' };

function beginError(code: string | undefined): { status: number; error: string } {
  if (code === '42501') return { status: 403, error: 'not_member' };
  if (code === 'GDAOF') return { status: 403, error: 'off' };
  if (code === 'GDRTE') return { status: 429, error: 'limit' };
  if (code === 'GDCAP') return { status: 429, error: 'cap' };
  if (code === '22023') return { status: 400, error: 'bad_request' };
  return { status: 500, error: 'db' };
}

export async function handleAsk(req: Request, deps: AskDeps): Promise<Response> {
  const started = deps.now();
  const origin = req.headers.get('origin');
  const cors = corsFor(origin);
  const log: Record<string, unknown> = { fn: FN_VERSION };
  const reply = (body: unknown, status: number) => {
    log.status = status;
    log.ms = deps.now() - started;
    deps.log(JSON.stringify(log));
    return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  };

  if (origin !== null && !originAllowed(origin)) return reply({ error: 'origin' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Emergency stop (scripts/ask-switch.mjs): before the database or any AI is touched.
  if (/^(1|true|on|yes)$/i.test(deps.env('ASK_OFF') ?? '')) return reply({ error: 'stopped' }, 503);
  if (req.method === 'GET') {
    const keys = Object.fromEntries(ASK_PROVIDERS.map((p) => [p, (deps.env(KEY_NAMES[p])?.trim().length ?? 0) >= 20]));
    return reply({ ok: true, fn_version: FN_VERSION, keys }, 200);
  }
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(auth)) return reply({ error: 'unauthorized' }, 401);

  const raw = await readBody(req, MAX_BODY);
  if (raw instanceof Response) return reply({ error: raw.status === 413 ? 'too_large' : 'bad_json' }, raw.status);
  const body = Body.safeParse(raw);
  if (!body.success) return reply({ error: 'bad_request' }, 400);

  const db = deps.userDb(auth);
  const { data: who } = await db.auth.getUser();
  if (!who.user) return reply({ error: 'unauthorized' }, 401);

  // Checked before anything is counted: a refused question costs nothing.
  const question = questionCheck(body.data.question);
  if (!question.ok) {
    log.err = `q_${question.reason}`;
    return reply({ error: 'unsafe_question', reason: question.reason }, 422);
  }

  const begun = await db.rpc('rpc_ask_begin', { p_household: body.data.household_id, p_request: body.data.request_id });
  if (begun.error) {
    const e = beginError(begun.error.code);
    log.err = e.error;
    return reply({ error: e.error }, e.status);
  }
  const start = Begin.safeParse(begun.data);
  if (!start.success) {
    log.err = 'begin_shape';
    return reply({ error: 'db' }, 500);
  }
  const { steps, today, used, limit, nonce } = start.data;

  const keys: Partial<Record<Provider, string>> = {};
  for (const p of ASK_PROVIDERS) {
    const v = deps.env(KEY_NAMES[p])?.trim();
    if (v && v.length >= 20) keys[p] = v;
  }

  const user = buildUser(today, question.text);
  try {
    assertAskUser(user); // the last gate before anything leaves
  } catch (err) {
    log.err = err instanceof UnsafeAsk ? `gate_${err.reason}` : 'gate';
    return reply({ error: 'unsafe_question' }, 422);
  }

  const calls: Array<{ provider: Provider; model: string; input_tokens: number; output_tokens: number; cost_usd: number; ok: boolean; error: string | null }> = [];
  let plan: AskPlan | null = null;
  let answeredBy: ModelRef | null = null;
  for (const ref of steps.slice(0, 2)) {
    const r = await deps.callModel(ref, { system: ASK_SYSTEM, user, schemaName: 'ask_plan', schema: PLAN_SCHEMA, maxOutputTokens: 700 }, keys, MODEL_TIMEOUT_MS);
    const p = r.ok && r.text ? toPlan(r.text, today) : null;
    calls.push({
      provider: ref.provider, model: ref.model, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
      cost_usd: Math.round(r.costUsd * 1e6) / 1e6, ok: !!p, error: p ? null : (r.error ?? 'bad_plan'),
    });
    if (p) {
      plan = p;
      answeredBy = ref;
      break;
    }
  }

  const recorded = await db.rpc('rpc_ask_record', {
    p_household: body.data.household_id, p_request: body.data.request_id, p_nonce: nonce, p_calls: calls,
  });
  log.calls = calls.length;
  log.provider = answeredBy?.provider ?? null;
  // What isn't counted isn't answered: the cap and the daily limit rely on the record.
  if (recorded.error) {
    log.err = `record_${recorded.error.code ?? 'error'}`;
    return reply({ error: 'db' }, 500);
  }

  if (!plan || !answeredBy) {
    log.err = calls.map((c) => c.error).join('|').slice(0, 60);
    return reply({ error: 'no_answer', used, limit }, 502);
  }
  log.ok = true;
  log.tools = plan.calls.length;
  const out: AskReply = { plan, provider: answeredBy.provider, model: answeredBy.model, used, limit, today };
  return reply(out, 200);
}
