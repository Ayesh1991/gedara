// AI gateway, part 2: one call to one model, returning JSON text + token counts (Phase 9b).
// Plain fetch, no SDKs. Every call asks for structured output (a strict JSON schema) and the answer is
// validated with Zod by the caller anyway. Keys come from the Edge Function's secrets only.
//
// Prices are per 1M tokens (USD) from the providers' pricing pages, 2026-10-22. Groq's free plan
// costs nothing (its limits are per day, see the daily request cap).

export type Provider = 'groq' | 'gemini' | 'openai';

export interface ModelRef {
  provider: Provider;
  model: string;
}

export const PRICES: Record<string, { input: number; output: number; free?: boolean }> = {
  'groq/openai/gpt-oss-120b': { input: 0, output: 0, free: true },
  'groq/openai/gpt-oss-20b': { input: 0, output: 0, free: true },
  'gemini/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.0 },
};

export const KEY_NAMES: Record<Provider, string> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export interface CallInput {
  system: string;
  user: string;
  schemaName: string;
  /** strict JSON Schema: every property required, additionalProperties false, nullable as ["x","null"] */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface CallResult {
  ok: boolean;
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  /** short machine code, never provider text: 'http_429', 'http_400', 'timeout', 'no_key', 'empty' … */
  error: string | null;
  costUsd: number;
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function costOf(ref: ModelRef, inputTokens: number, outputTokens: number): number {
  const p = PRICES[`${ref.provider}/${ref.model}`];
  if (!p || p.free) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Gemini's older `responseSchema` (OpenAPI subset): ["string","null"] → { type: "string", nullable }. */
function toOpenApi(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenApi);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type' && Array.isArray(v)) {
      const t = v.filter((x) => x !== 'null');
      out.type = t[0];
      if (v.includes('null')) out.nullable = true;
    } else out[k] = toOpenApi(v);
  }
  return out;
}

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const fail = (error: string): CallResult => ({ ok: false, text: null, inputTokens: 0, outputTokens: 0, error, costUsd: 0 });

export async function callModel(
  ref: ModelRef,
  input: CallInput,
  keys: Partial<Record<Provider, string>>,
  fetchImpl: Fetch = fetch,
  timeoutMs = 45_000,
): Promise<CallResult> {
  const key = keys[ref.provider];
  if (!key) return fail('no_key');
  try {
    if (ref.provider === 'gemini') return await callGemini(ref, input, key, fetchImpl, timeoutMs);
    return await callOpenAiStyle(ref, input, key, fetchImpl, timeoutMs);
  } catch (err) {
    return fail(err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network');
  }
}

// Groq and OpenAI share the Chat Completions shape.
async function callOpenAiStyle(ref: ModelRef, input: CallInput, key: string, fetchImpl: Fetch, timeoutMs: number) {
  const url = ref.provider === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const body: Record<string, unknown> = {
    model: ref.model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema: input.schema } },
    reasoning_effort: 'low',
  };
  if (ref.provider === 'groq') {
    body.temperature = 0;
    body.max_completion_tokens = input.maxOutputTokens + 1024; // gpt-oss reasons before it answers
  } else {
    body.max_completion_tokens = input.maxOutputTokens + 2048;
  }
  let res = await post(fetchImpl, url, { Authorization: `Bearer ${key}` }, body, timeoutMs);
  if (res.status === 400) {
    // a model that doesn't take a reasoning effort: once more without it
    delete body.reasoning_effort;
    res = await post(fetchImpl, url, { Authorization: `Bearer ${key}` }, body, timeoutMs);
  }
  if (!res.ok) return fail(`http_${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content ?? null;
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  const costUsd = costOf(ref, inputTokens, outputTokens);
  if (!text) return { ...fail(json.choices?.[0]?.message?.refusal ? 'refused' : 'empty'), inputTokens, outputTokens, costUsd };
  return { ok: true, text, inputTokens, outputTokens, error: null, costUsd };
}

async function callGemini(ref: ModelRef, input: CallInput, key: string, fetchImpl: Fetch, timeoutMs: number) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ref.model)}:generateContent`;
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: input.schema,
    temperature: 0,
    maxOutputTokens: input.maxOutputTokens,
    // matching needs no long thinking; thinking tokens are billed as output
    thinkingConfig: { thinkingBudget: 0 },
  };
  const body = {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [{ role: 'user', parts: [{ text: input.user }] }],
    generationConfig,
  };
  let res = await post(fetchImpl, url, { 'x-goog-api-key': key }, body, timeoutMs);
  if (res.status === 400) {
    // older field name for the schema (OpenAPI subset)
    delete generationConfig.responseJsonSchema;
    generationConfig.responseSchema = toOpenApi(input.schema);
    res = await post(fetchImpl, url, { 'x-goog-api-key': key }, body, timeoutMs);
  }
  if (!res.ok) return fail(`http_${res.status}`);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = (json.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('') || null;
  const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0);
  const costUsd = costOf(ref, inputTokens, outputTokens);
  if (!text) return { ...fail('empty'), inputTokens, outputTokens, costUsd };
  return { ok: true, text, inputTokens, outputTokens, error: null, costUsd };
}
