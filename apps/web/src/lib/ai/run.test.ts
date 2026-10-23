import { describe, expect, it, vi } from 'vitest';
import { runEval, runMatching, type Bundle } from '@match/run';

// Phase 9b: one matching run with a fake AI. Rules first, the AI only for the rest, nothing asked twice,
// nothing at all when AI is off or the budget is spent, and the accuracy test.

const HH = {
  grocery: 'c-groc', rice: 'c-rice', services: 'c-serv', other: 'c-oth', subs: 'c-subs', transport: 'c-tran', tolls: 'c-toll',
};

function bundle(p: Partial<Bundle> = {}): Bundle {
  return {
    settings: { ai_enabled: true, monthly_cap_usd: 3, daily_requests: 150 },
    usage: { month_cost_usd: 0, today: {} },
    accounts: [
      { id: 'seylan', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 100000, institution: 'Seylan' },
      { id: 'match', kind: 'credit_card', is_suspense: true, archived: false, credit_limit: null },
    ],
    categories: [
      { id: HH.grocery, parent_id: null, key: 'grocery', name: 'Grocery', kind: 'expense', default_destiny: 'stock', archived: false },
      { id: HH.rice, parent_id: HH.grocery, key: null, name: 'Rice', kind: 'expense', default_destiny: 'stock', archived: false },
      { id: HH.services, parent_id: null, key: 'services', name: 'Services', kind: 'expense', default_destiny: 'expense', archived: false },
      { id: HH.other, parent_id: HH.services, key: null, name: 'Other service', kind: 'expense', default_destiny: 'expense', archived: false },
      { id: HH.subs, parent_id: HH.services, key: null, name: 'Subscriptions', kind: 'expense', default_destiny: 'expense', archived: false },
      { id: HH.transport, parent_id: null, key: 'transport', name: 'Transport', kind: 'expense', default_destiny: 'expense', archived: false },
      { id: HH.tolls, parent_id: HH.transport, key: null, name: 'Parking & tolls', kind: 'expense', default_destiny: 'expense', archived: false },
    ],
    products: [
      { id: 'p-keeri', name: 'Keeri samba', name_si: null, archived: false, category_id: HH.rice },
      { id: 'p-basmati', name: 'Basmati rice', name_si: null, archived: false, category_id: HH.rice },
      { id: 'p-sugar', name: 'Sugar', name_si: null, archived: false, category_id: HH.grocery },
    ],
    aliases: [{ alias_norm: 'white sugar 1kg', product_id: 'p-sugar', destiny: 'stock' }],
    held: [],
    merchant_memory: [],
    line_memory: [],
    suggestions: [],
    ...p,
  };
}

const line = (fp: string, raw_name: string, p: Partial<NonNullable<Bundle['lines']>[number]> = {}) => ({
  id: `l-${fp}`, fingerprint: fp, raw_name, qty: 1, unit_text: null, amount: 1200, category_id: HH.rice, destiny: 'stock',
  shop: 'Cargills', occurred_on: '2026-10-10', ...p,
});

/** A fake provider that answers every asked item with `answer(item)`. */
function fakeAi(answer: (item: Record<string, unknown>, task: string) => Record<string, unknown>) {
  const calls: Array<{ url: string; user: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages?: Array<{ content: string }>; contents?: Array<{ parts: Array<{ text: string }> }>; response_format?: { json_schema: { name: string } } };
    const user = JSON.parse(body.messages ? body.messages[1]!.content : body.contents![0]!.parts[0]!.text) as { items: Array<Record<string, unknown>> };
    calls.push({ url, user });
    const task = body.response_format?.json_schema.name ?? 'lines';
    const text = JSON.stringify({ items: user.items.map((it) => ({ i: it.i, ...answer(it, task) })) });
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 500, completion_tokens: 50 } }), { status: 200 });
  });
  return { fn, calls };
}

const KEYS = { groq: 'g', gemini: 'm', openai: 'o' };

describe('runMatching', () => {
  it('a learned name is a rule suggestion; the AI only sees the rest, by labels', async () => {
    const ai = fakeAi((it) => ({ destiny: 'stock', product: (it.candidates as string[])[0] ?? null, category: 'C2', confidence: 0.95 }));
    const out = await runMatching(bundle({ lines: [line('b1-0', 'WHITE SUGAR 1KG', { category_id: HH.grocery }), line('b1-1', 'KEERI SMBA 5KG')] }),
      { keys: KEYS, fetchImpl: ai.fn });
    expect(out.suggestions.find((s) => s.target_key === 'b1-0')).toMatchObject({ pattern: 'rule', proposal: { product_id: 'p-sugar' } });
    expect(ai.calls).toHaveLength(1);
    const asked = JSON.stringify(ai.calls[0]!.user);
    expect(asked).not.toContain('p-keeri'); // real ids never leave
    expect(asked).not.toContain('WHITE SUGAR');
    expect(out.suggestions.find((s) => s.target_key === 'b1-1')).toMatchObject({
      task: 'line_product', line_id: 'l-b1-1', proposal: { destiny: 'stock', product_id: 'p-keeri' }, pattern: 'ai1', // (the trigram score alone is only a "maybe")
    });
  });

  it('an unchanged item is not asked again; AI off asks nothing', async () => {
    const ai = fakeAi(() => ({ destiny: 'expense', product: null, category: 'C2', confidence: 0.95 }));
    const first = await runMatching(bundle({ lines: [line('b2-0', 'PLASTIC BAG')] }), { keys: KEYS, fetchImpl: ai.fn });
    const s = first.suggestions[0]!;
    await runMatching(bundle({ lines: [line('b2-0', 'PLASTIC BAG')], suggestions: [{ task: s.task, target_key: s.target_key, input_hash: s.input_hash, status: 'rejected' }] }),
      { keys: KEYS, fetchImpl: ai.fn });
    expect(ai.calls).toHaveLength(1);
    const off = fakeAi(() => ({}));
    const quiet = await runMatching(bundle({ settings: { ai_enabled: false }, lines: [line('b3-0', 'PLASTIC BAG')] }), { keys: KEYS, fetchImpl: off.fn });
    expect(off.fn).not.toHaveBeenCalled();
    expect(quiet.stats.ai_enabled).toBe(false);
  });

  it('the monthly cap stops every call', async () => {
    const ai = fakeAi(() => ({ destiny: 'expense', product: null, category: 'C2', confidence: 0.95 }));
    await runMatching(bundle({ usage: { month_cost_usd: 3, today: {} }, lines: [line('b4-0', 'PLASTIC BAG')] }), { keys: KEYS, fetchImpl: ai.fn });
    expect(ai.fn).not.toHaveBeenCalled();
  });

  it('alerts: an untaught merchant gets a category; a taught one or ETC asks nothing', async () => {
    const ai = fakeAi((_it, task) => (task === 'sms_category' ? { category: 'C3', confidence: 0.95 } : { candidate: null, confidence: 0.9 }));
    const sms = (id: string, merchant: string) => ({
      id, sender: 'Seylan Bank', body: '', received_at: '2026-10-10T05:00:00Z', fingerprint: id, kind: 'card_charge', parser: 'seylan.charge',
      institution: 'Seylan', last_digits: '6029', account_id: 'seylan', amount: 550, currency: 'LKR', balance_after: null,
      merchant_text: merchant, bank_txn_id: null, occurred_on: '2026-10-10', occurred_at: '10:30:00', transaction_id: null, ignored: false,
    });
    const out = await runMatching(bundle({
      sms: [sms('s1', 'Google One 650-2530000 US'), sms('s2', 'KEELLS SUPER')],
      merchant_memory: [{ merchant_norm: 'keells super', category_id: HH.grocery, account_id: null }],
      candidates: [], linked: [],
    }), { keys: KEYS, fetchImpl: ai.fn });
    expect(ai.calls).toHaveLength(1);
    expect(JSON.stringify(ai.calls[0]!.user)).toContain('Google One 650-####### US');
    expect(out.suggestions).toEqual([expect.objectContaining({ task: 'sms_category', sms_id: 's1', proposal: { category_id: HH.subs } })]);
  });

  it('a suggestion whose item was dealt with goes stale', async () => {
    const out = await runMatching(bundle({ lines: [], suggestions: [{ task: 'line_product', target_key: 'gone', input_hash: 'h', status: 'pending' }] }), { keys: KEYS });
    expect(out.stale).toEqual([{ task: 'line_product', target_key: 'gone' }]);
  });
});

describe('runEval', () => {
  it('scores rules and AI against what a person chose, in batches', async () => {
    const ai = fakeAi((it, task) => (task === 'sms_category'
      ? { category: 'C3', confidence: 0.9 }
      : { destiny: 'stock', product: (it.candidates as string[])[0] ?? null, category: 'C2', confidence: 0.92 }));
    const lines = Array.from({ length: 30 }, (_, k) => line(`e${k}`, k % 2 ? 'KEERI SMBA 5KG' : 'BASMATHI 1KG', { product_id: k % 2 ? 'p-keeri' : 'p-basmati' }));
    const first = await runEval(bundle({ eval_lines: lines, eval_sms: [{ id: 's9', merchant_text: 'NETFLIX.COM', amount: 2990, kind: 'card_charge', category_id: HH.subs }] }),
      { keys: KEYS, fetchImpl: ai.fn });
    expect(first.total).toBe(31);
    expect(first.evals.filter((e) => e.task === 'line_product')).toHaveLength(24);
    expect(first.remaining).toBe(6);
    expect(first.evals.find((e) => e.task === 'sms_category')).toMatchObject({ ai_correct: true });
    expect(first.evals.filter((e) => e.ai_correct).length).toBeGreaterThan(20);
    const second = await runEval(bundle({ eval_lines: lines, eval_sms: [], evaluated: first.evals.map((e) => `${e.task}:${e.target_key}`) }),
      { keys: KEYS, fetchImpl: ai.fn });
    expect(second.evals).toHaveLength(6);
    expect(second.remaining).toBe(0);
  });
});
