import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FN_VERSION, handleAsk, MAX_BODY, type AskDb, type AskDeps } from '@ask/handler';
import { ASK_SYSTEM } from '@ask/prompt';
import type { CallInput, CallResult, ModelRef } from '@ai/providers';

// Phase 10 · the ask-gedara Edge Function, run without Deno: kill switch, origins, size, login, the question
// check before anything is counted, the begin/record RPCs (the only database calls), the Groq → OpenAI
// fallback, and logs that never hold the question, the plan or a number.

const HOUSEHOLD = '00000000-0000-4000-8000-0000000000aa';
const REQUEST = '00000000-0000-4000-8000-0000000000bb';
const JWT = `Bearer ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
const QUESTION = 'How much did we spend on fish since June 2026?';
const GOOD_PLAN = JSON.stringify({
  calls: [{ tool: 'ask_spend', about: 'fish', from: '2026-06-01', to: '2026-11-03', group: null, view: null, within_days: null, month: null, limit: null }],
  refusal: null,
});
const BEGIN = {
  steps: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'openai', model: 'gpt-6-luna' }],
  today: '2026-11-03', used: 3, limit: 20, nonce: 'f'.repeat(64),
};

const ok = (text: string, cost = 0): CallResult => ({ ok: true, text, inputTokens: 1800, outputTokens: 90, error: null, costUsd: cost });
const failed = (error: string): CallResult => ({ ok: false, text: null, inputTokens: 0, outputTokens: 0, error, costUsd: 0 });

function setup(opts: { env?: Record<string, string>; begin?: { data?: unknown; error?: { code: string } | null }; user?: boolean; models?: CallResult[] } = {}) {
  const env: Record<string, string> = { GROQ_API_KEY: 'g'.repeat(30), OPENAI_API_KEY: 'o'.repeat(30), ...opts.env };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) =>
    name === 'rpc_ask_begin'
      ? { data: opts.begin?.data ?? BEGIN, error: opts.begin?.error ?? null }
      : { data: { ok: true }, error: null });
  const db: AskDb = { auth: { getUser: async () => ({ data: { user: opts.user === false ? null : { id: 'u1' } } }) }, rpc };
  const userDb = vi.fn(() => db);
  const models = [...(opts.models ?? [ok(GOOD_PLAN)])];
  const callModel = vi.fn(async (_ref: ModelRef, _input: CallInput) => models.shift() ?? failed('empty'));
  const lines: string[] = [];
  const deps: AskDeps = {
    env: (n) => env[n], userDb, callModel: (ref, input) => callModel(ref, input), now: () => 1000, log: (l) => lines.push(l),
  };
  return { deps, rpc, userDb, callModel, lines };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://x.supabase.co/functions/v1/ask-gedara', {
    method: 'POST',
    headers: { authorization: JWT, 'content-type': 'application/json', origin: 'https://gedara.vercel.app', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const ask = (q = QUESTION) => post({ household_id: HOUSEHOLD, request_id: REQUEST, question: q });

describe('ask-gedara handler', () => {
  it('answers with a plan, the model that made it, and today\'s count', async () => {
    const t = setup();
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://gedara.vercel.app');
    expect(await res.json()).toEqual({
      plan: { calls: [{ tool: 'ask_spend', args: { p_about: 'fish', p_from: '2026-06-01', p_to: '2026-11-03', p_group: null } }], refusal: null },
      provider: 'groq', model: 'openai/gpt-oss-120b', used: 3, limit: 20, today: '2026-11-03',
    });
  });

  it('sends the AI only the fixed instructions, today and the question', async () => {
    const t = setup();
    await handleAsk(ask(), t.deps);
    const input = t.callModel.mock.calls[0]![1];
    expect(input.system).toBe(ASK_SYSTEM);
    expect(JSON.parse(input.user)).toEqual({ today: '2026-11-03', question: QUESTION });
  });

  it('touches the database only through rpc_ask_begin and rpc_ask_record, as the asker', async () => {
    const t = setup();
    await handleAsk(ask(), t.deps);
    expect(t.userDb).toHaveBeenCalledWith(JWT);
    expect(t.rpc.mock.calls.map((c) => c[0])).toEqual(['rpc_ask_begin', 'rpc_ask_record']);
    expect(t.rpc.mock.calls[1]![1]).toEqual({
      p_household: HOUSEHOLD, p_request: REQUEST, p_nonce: 'f'.repeat(64),
      p_calls: [{ provider: 'groq', model: 'openai/gpt-oss-120b', input_tokens: 1800, output_tokens: 90, cost_usd: 0, ok: true, error: null }],
    });
  });

  it('never sends the one-time record secret to the browser', async () => {
    const t = setup();
    const text = await (await handleAsk(ask(), t.deps)).text();
    expect(text).not.toContain('f'.repeat(64));
    expect(text).not.toMatch(/nonce/);
  });

  it('withholds the plan when its cost could not be recorded', async () => {
    const t = setup();
    t.rpc.mockImplementation(async (name: string) =>
      name === 'rpc_ask_begin' ? { data: BEGIN, error: null } : { data: {}, error: { code: '22023' } });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db' });
  });

  it('falls back from Groq to OpenAI and records both calls', async () => {
    const t = setup({ models: [failed('http_429'), ok(GOOD_PLAN, 0.0002345678)] });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(200);
    expect((await res.json()).provider).toBe('openai');
    expect((t.rpc.mock.calls[1]![1].p_calls as Array<{ error: string | null; cost_usd: number }>).map((c) => [c.error, c.cost_usd]))
      .toEqual([['http_429', 0], [null, 0.000235]]);
  });

  it('tries the next model when a plan does not fit, and says so when none does', async () => {
    const bad = JSON.stringify({ calls: [{ tool: 'sql', about: 'select 1' }], refusal: null });
    const t = setup({ models: [ok(bad), ok('not json')] });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'no_answer', used: 3, limit: 20 });
    expect(t.callModel).toHaveBeenCalledTimes(2);
  });

  it('never asks Gemini, even if the household\'s steps list it', async () => {
    const t = setup({ begin: { data: { ...BEGIN, steps: [{ provider: 'gemini', model: 'gemini-3.8-flash' }] } } });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(500);
    expect(t.callModel).not.toHaveBeenCalled();
  });

  it('stops at once with the kill switch, before the database or any AI', async () => {
    const t = setup({ env: { ASK_OFF: '1' } });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(503);
    expect(t.userDb).not.toHaveBeenCalled();
    expect(t.callModel).not.toHaveBeenCalled();
  });

  it('answers the browser\'s preflight only for Gedara\'s own pages', async () => {
    const t = setup();
    const pre = (origin: string) => new Request('https://x/functions/v1/ask-gedara', { method: 'OPTIONS', headers: { origin } });
    const mine = await handleAsk(pre('https://gedara-git-phase-10-ayeshmantha.vercel.app'), t.deps);
    expect(mine.status).toBe(204);
    expect(mine.headers.get('access-control-allow-origin')).toBe('https://gedara-git-phase-10-ayeshmantha.vercel.app');
    const theirs = await handleAsk(pre('https://evil.example'), t.deps);
    expect(theirs.status).toBe(403);
    expect(theirs.headers.get('access-control-allow-origin')).toBeNull();
  });

  it.each([
    ['another website', ask(), { origin: 'https://gedara.vercel.app.evil.example' }, 403],
    ['a look-alike preview', ask(), { origin: 'https://gedara-x-someoneelse.vercel.app' }, 403],
  ])('refuses %s', async (_n, _r, headers, status) => {
    const t = setup();
    const res = await handleAsk(post({ household_id: HOUSEHOLD, request_id: REQUEST, question: QUESTION }, headers), t.deps);
    expect(res.status).toBe(status);
    expect(t.userDb).not.toHaveBeenCalled();
  });

  it('needs a login', async () => {
    const t = setup();
    expect((await handleAsk(post({ household_id: HOUSEHOLD, request_id: REQUEST, question: QUESTION }, { authorization: '' }), t.deps)).status).toBe(401);
    const t2 = setup({ user: false });
    expect((await handleAsk(ask(), t2.deps)).status).toBe(401);
    expect(t2.rpc).not.toHaveBeenCalled();
  });

  it('refuses a body over 2 KB and malformed bodies', async () => {
    const t = setup();
    const big = post({ household_id: HOUSEHOLD, request_id: REQUEST, question: 'x'.repeat(MAX_BODY) });
    expect((await handleAsk(big, t.deps)).status).toBe(413);
    expect((await handleAsk(post('{"household_id":'), t.deps)).status).toBe(400);
    expect((await handleAsk(post({ household_id: 'nope', request_id: REQUEST, question: QUESTION }), t.deps)).status).toBe(400);
    expect((await handleAsk(post({ household_id: HOUSEHOLD, request_id: REQUEST, question: QUESTION, sql: 'x' }), t.deps)).status).toBe(400);
    expect(t.userDb).not.toHaveBeenCalled();
  });

  it('refuses an OTP or code-like question before anything is counted', async () => {
    const t = setup();
    const res = await handleAsk(ask('My OTP is 482913, what did I buy?'), t.deps);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'unsafe_question', reason: 'otp' });
    expect(t.rpc).not.toHaveBeenCalled();
    expect(t.callModel).not.toHaveBeenCalled();
  });

  it.each([
    ['GDAOF', 403, 'off'],
    ['GDRTE', 429, 'limit'],
    ['GDCAP', 429, 'cap'],
    ['42501', 403, 'not_member'],
  ])('maps %s from rpc_ask_begin to %i %s, without asking an AI', async (code, status, error) => {
    const t = setup({ begin: { error: { code } } });
    const res = await handleAsk(ask(), t.deps);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(t.callModel).not.toHaveBeenCalled();
  });

  it('logs one line per request with counts and codes only', async () => {
    const t = setup({ models: [failed('http_429'), ok(GOOD_PLAN)] });
    await handleAsk(ask(), t.deps);
    expect(t.lines).toHaveLength(1);
    const line = JSON.parse(t.lines[0]!);
    expect(line).toEqual({ fn: FN_VERSION, calls: 2, provider: 'openai', ok: true, tools: 1, status: 200, ms: 0 });
    expect(t.lines[0]).not.toMatch(/fish|june|2026|1800/i);
  });

  it('never uses the service role', () => {
    const root = path.resolve(import.meta.dirname, '../../../../../supabase/functions');
    for (const f of ['ask-gedara/index.ts', '_shared/ask/handler.ts', '_shared/ask/plan.ts', '_shared/ask/guard.ts', '_shared/ask/cors.ts']) {
      expect(readFileSync(path.join(root, f), 'utf8')).not.toMatch(/SERVICE_ROLE|service_role/);
    }
  });

  it('GET says which keys are set, never a key', async () => {
    const t = setup();
    const res = await handleAsk(new Request('https://x/functions/v1/ask-gedara', { method: 'GET', headers: { authorization: JWT } }), t.deps);
    expect(await res.json()).toEqual({ ok: true, fn_version: FN_VERSION, keys: { groq: true, openai: true } });
  });
});
