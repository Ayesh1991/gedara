import { describe, expect, it, vi } from 'vitest';
import { assertSafeRequest, billText, day, smsText, UnsafePrompt } from '@ai/guard';
import { combine, decide, type AskItem, type Budget, type Vote } from '@ai/ladder';
import { costOf, type ModelRef } from '@ai/providers';
import { parseAnswers, type AnswerOf } from '@ai/tasks';
import { parseSms } from '@sms/parse';
import { REAL_ALERTS, SECRET_CORPUS } from '@/lib/__fixtures__/secretCorpus';

// Phase 9b · hard rule 1 at the AI gateway: nothing that looks like a bank code ever reaches fetch().

const GROQ: ModelRef = { provider: 'groq', model: 'openai/gpt-oss-120b' };
const GEMINI: ModelRef = { provider: 'gemini', model: 'gemini-2.5-flash' };
const OPENAI: ModelRef = { provider: 'openai', model: 'gpt-5.4-mini' };
const KEYS = { groq: 'g', gemini: 'm', openai: 'o' };
const open: Budget = { allow: () => true, spend: () => undefined };

type Line = AnswerOf<'lines'>;
const line = (i: number, p: Partial<Line> = {}): Line => ({ i, destiny: 'stock', product: 'P1', category: 'C1', confidence: 0.95, ...p });

/** A fetch that answers like the provider would, with the given items, and records every call. */
function fakeFetch(answers: Record<string, unknown[]>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    const provider = url.includes('groq') ? 'groq' : url.includes('googleapis') ? 'gemini' : 'openai';
    const text = JSON.stringify({ items: answers[provider] ?? [] });
    const body = provider === 'gemini'
      ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } }
      : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn, calls };
}

const items = (n: number): AskItem<Line>[] =>
  Array.from({ length: n }, (_, i) => ({ i, payload: { name: `KEERI SMBA ${i + 1}KG`, amount: 1250.5, day: '2026-10-14', candidates: ['P1', 'P2'] } }));
const shared = { categories: [{ id: 'C1', name: 'Grocery › Rice' }], products: [{ id: 'P1', name: 'Keeri samba' }, { id: 'P2', name: 'Basmati' }] };
const labelOk = (a: Line) => ['C1'].includes(a.category) && (a.product === null || ['P1', 'P2'].includes(a.product));

describe('guard: text that may go to an AI', () => {
  it.each(SECRET_CORPUS)('a bank-alert field with a code never passes: %s', (text) => {
    expect(() => smsText(text)).toThrow(UnsafePrompt);
  });
  it.each(SECRET_CORPUS)('bill text with a code never passes either: %s', (text) => {
    expect(() => billText(text)).toThrow(UnsafePrompt);
  });
  it('alert merchants pass with long numbers hidden', () => {
    expect(smsText('Google One 650-2530000 US')).toBe('Google One 650-####### US');
    expect(smsText('TEMU.COM +442033454976IE')).toBe('TEMU.COM +############IE');
    expect(smsText('CARGILLS - RAJAGIRIYA 3 COLOMBO 01 LK')).toBe('CARGILLS - RAJAGIRIYA 3 COLOMBO 01 LK');
  });
  it('real bill names pass: pack sizes and model numbers are not codes', () => {
    for (const name of ['ANCHOR FC MILK PWDR 400G', 'COCA COLA 1500 ML', 'SAMSUNG UA55AU7700 TV', 'KEERI SMBA 5KG', 'A4 PAPER 80GSM 500 SHEETS', 'Eggs 10 pcs']) {
      expect(billText(name), name).toBe(name);
    }
  });
  it('card numbers and 9+-digit numbers are hidden from bill text', () => {
    expect(billText('PAID BY CARD 5524 **** **** 8873')).toBe('PAID BY CARD ****');
    expect(billText('INVOICE 1234567890 THANK YOU')).toBe('INVOICE ########## THANK YOU');
  });
  it('days are days', () => {
    expect(day('2026-10-14')).toBe('2026-10-14');
    expect(() => day('482913')).toThrow(UnsafePrompt);
  });
  it('a whole alert text could never be sent (bank ids are 9+ digits); its parsed merchant can', () => {
    for (const [sender, body] of REAL_ALERTS) {
      const v = parseSms({ sender, body, receivedAt: '2026-10-01T04:30:00Z' });
      if (!v.keep) throw new Error(body);
      expect(() => assertSafeRequest(JSON.stringify({ merchant: smsText(v.sms.merchant_text) })), body).not.toThrow();
    }
    expect(() => assertSafeRequest(JSON.stringify({ body: REAL_ALERTS[21]![1] }))).toThrow(UnsafePrompt);
  });
});

describe('the last gate: no request with a code is ever sent', () => {
  it('an OTP planted in ANY text field of a request means fetch() is never called', async () => {
    for (const otp of SECRET_CORPUS) {
      for (const field of ['name', 'shop', 'merchant', 'note']) {
        const { fn } = fakeFetch({ groq: [line(0)] });
        const planted: AskItem<Line>[] = [{ i: 0, payload: { name: 'MILK 1L', [field]: otp } }];
        const { decisions } = await decide({ task: 'lines', items: planted, shared, steps: [GROQ, GEMINI, OPENAI], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
        expect(fn, `${field}: ${otp}`).not.toHaveBeenCalled();
        expect(decisions.get(0)?.blocked).toBe(true);
      }
      // …also in the shared part of the request
      const { fn } = fakeFetch({ groq: [line(0)] });
      await decide({ task: 'lines', items: items(1), shared: { ...shared, products: [{ id: 'P1', name: otp }] }, steps: [GROQ], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
      expect(fn, `shared: ${otp}`).not.toHaveBeenCalled();
    }
  });
  it('a 9+-digit number anywhere stops the request', () => {
    expect(() => assertSafeRequest(JSON.stringify({ amount: 123456789 }))).toThrow(UnsafePrompt);
    expect(() => assertSafeRequest(JSON.stringify({ day: '482913' }))).toThrow(UnsafePrompt);
  });
});

describe('ladder: cheap first, stronger only when unsure', () => {
  it('a sure first answer stops at Groq', async () => {
    const { fn, calls } = fakeFetch({ groq: [line(0), line(1)] });
    const { decisions, usage } = await decide({ task: 'lines', items: items(2), shared, steps: [GROQ, GEMINI, OPENAI], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('api.groq.com');
    expect(decisions.get(0)).toMatchObject({ answer: { product: 'P1' }, pattern: 'ai1' });
    expect(decisions.get(0)!.confidence).toBeCloseTo(0.9);
    expect(usage).toEqual([expect.objectContaining({ provider: 'groq', ok: true, cost_usd: 0 })]);
  });
  it('unsure → Gemini; agreement makes it sure', async () => {
    const { fn, calls } = fakeFetch({ groq: [line(0, { confidence: 0.6 })], gemini: [line(0, { confidence: 0.8 })] });
    const { decisions, usage } = await decide({ task: 'lines', items: items(1), shared, steps: [GROQ, GEMINI, OPENAI], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['api.groq.com', 'generativelanguage.googleapis.com']);
    expect(decisions.get(0)).toMatchObject({ pattern: 'ai1+ai2', confidence: 0.95 });
    expect(usage[1]!.cost_usd).toBeCloseTo((1000 * 0.3 + 100 * 2.5) / 1e6);
  });
  it('disagreement → OpenAI referees; two of three is not sure', async () => {
    const { fn, calls } = fakeFetch({
      groq: [line(0, { product: 'P1', confidence: 0.7 })],
      gemini: [line(0, { product: 'P2', confidence: 0.9 })],
      openai: [line(0, { product: 'P2', confidence: 0.9 })],
    });
    const { decisions } = await decide({ task: 'lines', items: items(1), shared, steps: [GROQ, GEMINI, OPENAI], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
    expect(calls).toHaveLength(3);
    expect(decisions.get(0)).toMatchObject({ answer: { product: 'P2' }, pattern: 'ai2+ai3/split', confidence: 0.75 });
  });
  it('an answer naming an id we never sent counts as no answer', async () => {
    const { fn } = fakeFetch({ groq: [line(0, { product: 'P99' })], gemini: [], openai: [] });
    const { decisions } = await decide({ task: 'lines', items: items(1), shared, steps: [GROQ, GEMINI, OPENAI], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
    expect(decisions.get(0)).toMatchObject({ answer: null, confidence: 0 });
  });
  it('the budget stops calls; a missing key skips that model', async () => {
    const { fn, calls } = fakeFetch({ groq: [line(0, { confidence: 0.5 })], gemini: [line(0)] });
    const capped: Budget = { allow: (ref) => ref.provider === 'groq', spend: () => undefined };
    await decide({ task: 'lines', items: items(1), shared, steps: [GROQ, GEMINI], keys: KEYS, budget: capped, labelOk, fetchImpl: fn });
    expect(calls).toHaveLength(1);
    const noKey = fakeFetch({ gemini: [line(0)] });
    const { usage } = await decide({ task: 'lines', items: items(1), shared, steps: [GROQ, GEMINI], keys: { gemini: 'm' }, budget: open, labelOk, fetchImpl: noKey.fn });
    expect(usage.map((u) => [u.provider, u.error])).toEqual([['groq', 'no_key'], ['gemini', null]]);
    expect(noKey.calls).toHaveLength(1);
  });
  it('the rules count as a vote', () => {
    const votes: Vote<Line>[] = [{ step: 1, model: 'groq', answer: line(0, { confidence: 0.7 }) }];
    expect(combine('lines', votes, { answer: line(0), facets: [0] })).toMatchObject({ pattern: 'rule+ai1', confidence: 0.7 });
    // (category facet: one model at 0.7, no rule vote there → 0.7 overall)
    expect(combine('lines', [{ step: 1, model: 'g', answer: line(0, { confidence: 0.85 }) }], { answer: line(0, { product: 'P2' }), facets: [0] }).confidence).toBe(0.5);
    expect(combine('lines', [], { answer: line(0), facets: [0] })).toMatchObject({ pattern: 'rule', confidence: 0.6 });
  });
});

describe('rate limits', () => {
  it('a 429 with a short Retry-After is waited out once', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [line(0)] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    });
    const p = decide({ task: 'lines', items: items(1), shared, steps: [GROQ], keys: KEYS, budget: open, labelOk, fetchImpl: fn });
    await vi.advanceTimersByTimeAsync(2_500);
    const { decisions } = await p;
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(decisions.get(0)?.answer?.product).toBe('P1');
  });
});

describe('answers', () => {
  it('Zod drops malformed answers, unknown ids and indexes answered twice', () => {
    const text = JSON.stringify({ items: [line(0), { i: 1, destiny: 'fridge' }, line(2, { category: 'C9' }), line(3), line(3, { product: 'P2' }), line(7)] });
    const got = parseAnswers('lines', text, new Set([0, 1, 2, 3]), labelOk);
    expect([...got.keys()]).toEqual([0]);
    expect(parseAnswers('lines', 'not json', new Set([0]), labelOk).size).toBe(0);
  });
  it('costs follow the price list; Groq free is free', () => {
    expect(costOf(GROQ, 1_000_000, 1_000_000)).toBe(0);
    expect(costOf(OPENAI, 1_000_000, 1_000_000)).toBeCloseTo(5.25);
    // a model not on the price list counts as expensive, so the monthly cap still holds
    expect(costOf({ provider: 'gemini', model: 'gemini-9-ultra' }, 1_000_000, 1_000_000)).toBeCloseTo(35);
  });
});
