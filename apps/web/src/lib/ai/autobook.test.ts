import { describe, expect, it } from 'vitest';
import { AUTO_BAR, autobookAlerts, autobookRecord, qualifies, transferPayload, type AutoKind, type BookedLite } from '@match/book';
import { kindsOn, runMatching, type Bundle } from '@match/run';
import { analyseInbox, type SmsRow } from '@match/sms';

// Phase 9c: what Gedara may book by itself — certain answers only, the kinds switched on and qualified,
// never the AI — and each kind's record on the household's own decided alerts.

const C = { services: 'c-serv', mobile: 'c-mob', fees: 'c-fees', grocery: 'c-groc', otherGrocery: 'c-ogroc', other: 'c-oth', misc: 'c-misc' };
const cat = (id: string, parent_id: string | null, key: string | null, name: string) =>
  ({ id, parent_id, key, name, kind: 'expense', default_destiny: 'expense', archived: false });
const categories = [
  cat(C.services, null, 'services', 'Services'), cat(C.mobile, C.services, null, 'Mobile & telephone'), cat(C.fees, C.services, null, 'Banking & fees'),
  cat(C.grocery, null, 'grocery', 'Grocery'), cat(C.otherGrocery, C.grocery, null, 'Other grocery'), cat(C.other, null, 'other', 'Other'), cat(C.misc, C.other, null, 'Miscellaneous'),
];
const accounts = [
  { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
  { id: 'card', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 300000, institution: 'Sampath' },
  { id: 'match', kind: 'credit_card', is_suspense: true, archived: false, credit_limit: null },
];

let n = 0;
function sms(p: Partial<SmsRow> & Pick<SmsRow, 'kind' | 'amount'> & { at: string }): SmsRow {
  n++;
  const [on, hm] = p.at.split(' ') as [string, string];
  const rest: Partial<SmsRow> & Pick<SmsRow, 'kind' | 'amount'> & { at?: string } = { ...p };
  delete rest.at;
  return {
    id: `s${n}`, sender: 'X', body: '', fingerprint: `s${n}`, institution: null, last_digits: null, account_id: null, currency: 'LKR',
    balance_after: null, merchant_text: null, bank_txn_id: null, parser: null, occurred_on: on, occurred_at: `${hm}:00`,
    received_at: new Date(Date.parse(`${on}T${hm}:00+05:30`)).toISOString(), transaction_id: null, ignored: false, ...rest,
  };
}
const ceft = (amount: number, at: string, p: Partial<SmsRow> = {}) =>
  sms({ kind: 'bank_debit', amount, at, account_id: 'boc', merchant_text: 'CEFT Transfer Debit', ...p });
const pay = (amount: number, at: string, p: Partial<SmsRow> = {}) => sms({ kind: 'card_payment', amount, at, account_id: 'card', merchant_text: 'Payment received', ...p });
const charge = (amount: number, at: string, merchant: string, p: Partial<SmsRow> = {}) =>
  sms({ kind: 'card_charge', amount, at, account_id: 'card', merchant_text: merchant, ...p });

const ALL = new Set<AutoKind>(['alert_link', 'alert_transfer', 'alert_note', 'category_evidence', 'category_rule', 'line_product']);
const ctx = (list: SmsRow[], p: { memory?: Array<[string, string]>; undone?: string[]; candidates?: Parameters<typeof analyseInbox>[1] } = {}) => ({
  householdId: 'h1', sms: list, analysis: analyseInbox(list, p.candidates ?? [], new Set(), accounts), accounts, categories,
  memory: new Map(p.memory ?? []), payees: new Map<string, string>(), undone: { sms: new Set(p.undone ?? []), lines: new Set<string>() },
});

describe('what Gedara books by itself', () => {
  it('a debit + the card payment it paid → one transfer with the fee (the same entry "Accept all" makes)', () => {
    const d = ceft(25025, '2026-10-02 09:00');
    const p = pay(25000, '2026-10-02 09:02');
    const items = autobookAlerts(ctx([d, p]), ALL);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'alert_transfer', action: 'post', sms_ids: [d.id, p.id] });
    expect(items[0]!.payload).toEqual(transferPayload([d, p], { kind: 'transfer', from: 'boc', to: 'card', total: 25000, fee: 25, pairId: p.id, confident: true }, 'h1', categories));
    expect(items[0]!.payload).toMatchObject({ fee: { amount: 25, category_id: C.fees } });
  });

  it('a card charge links to its bill in "to be matched"; a receipt-explained debit gets its category; notes are seen', () => {
    const c = charge(4520, '2026-09-03 19:05', 'CARGILLS FOOD CITY');
    const bill = { id: 'b1', type: 'expense', account_id: 'match', to_account_id: null, payee_text: 'Cargills', occurred_on: '2026-09-03', occurred_at: '19:00:00', total: 4520 };
    const d = ceft(198, '2026-10-20 18:21', { merchant_text: 'Online Transfer Debit' });
    const r = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog reload' });
    const items = autobookAlerts(ctx([c, d, r], { candidates: [bill] }), ALL);
    expect(items.map((i) => [i.kind, i.action])).toEqual([['alert_link', 'link'], ['category_evidence', 'post'], ['alert_note', 'seen']]);
    expect(items[0]).toMatchObject({ tx_id: 'b1' });
    expect(items[1]!.payload).toMatchObject({ type: 'expense', account_id: 'boc', total: 198, lines: [{ category_id: C.mobile, amount: 198 }] });
  });

  it('a shop you taught gets its category; a bank text that names no shop never does', () => {
    const keells = charge(3283, '2026-10-09 19:29', 'KEELLS SUPER');
    const blank = ceft(5000, '2026-10-09 10:00', { merchant_text: 'Online Transfer Debit' });
    const items = autobookAlerts(ctx([keells, blank], { memory: [['keells super', C.otherGrocery], ['online transfer debit', C.misc]] }), ALL);
    expect(items).toEqual([expect.objectContaining({ kind: 'category_rule', sms_ids: [keells.id], summary: expect.objectContaining({ category_id: C.otherGrocery }) })]);
  });

  it('never: a kind switched off, an undone alert, an estimated foreign amount, an unknown account, no category', () => {
    const d = ceft(25025, '2026-10-02 09:00');
    const p = pay(25000, '2026-10-02 09:02');
    expect(autobookAlerts(ctx([d, p]), new Set(['alert_note']))).toEqual([]);
    expect(autobookAlerts(ctx([d, p], { undone: [p.id] }), ALL)).toEqual([]);
    const usd = charge(20, '2026-10-10 21:47', 'ANTHROPIC* CLAUDE', { currency: 'USD', balance_after: 27225.56 });
    expect(autobookAlerts(ctx([usd], { memory: [['anthropic claude', C.misc]] }), ALL)).toEqual([]);
    const nowhere = charge(1000, '2026-10-11 10:00', 'KEELLS SUPER', { account_id: null });
    expect(autobookAlerts(ctx([nowhere], { memory: [['keells super', C.otherGrocery]] }), ALL)).toEqual([]);
    expect(autobookAlerts(ctx([charge(990, '2026-10-12 10:00', 'NEW SHOP')]), ALL)).toEqual([]);
  });
});

describe('a kind books only when switched on AND qualified', () => {
  it(`needs ≥ ${AUTO_BAR.right * 100} % on ≥ ${AUTO_BAR.of} past cases`, () => {
    expect(qualifies({ right: 20, of: 20 })).toBe(true);
    expect(qualifies({ right: 99, of: 100 })).toBe(true);
    expect(qualifies({ right: 19, of: 19 })).toBe(false);
    expect(qualifies({ right: 97, of: 100 })).toBe(false);
    expect(kindsOn({ ai_enabled: false, auto: ['alert_transfer', 'alert_note', 'bogus'], auto_record: { alert_transfer: { right: 30, of: 30 }, alert_note: { right: 5, of: 5 } } }))
      .toEqual(new Set(['alert_transfer']));
  });

  it('the run lists what it would book, only for those kinds; the AI is never asked for them', async () => {
    const d = ceft(25025, '2026-10-02 09:00');
    const p = pay(25000, '2026-10-02 09:02');
    const bundle: Bundle = {
      household_id: 'h1',
      settings: { ai_enabled: true, auto: ['alert_transfer'], auto_record: { alert_transfer: { right: 25, of: 25 } } },
      usage: { month_cost_usd: 0, today: {} }, accounts, categories, products: [], aliases: [], held: [], merchant_memory: [], line_memory: [],
      suggestions: [], sms: [d, p],
    };
    const out = await runMatching(bundle, { keys: {}, fetchImpl: async () => new Response('{}', { status: 500 }) });
    expect(out.autobook).toEqual([expect.objectContaining({ kind: 'alert_transfer', sms_ids: [d.id, p.id] })]);
    expect(out.stats.autobook).toBe(1);
  });
});

describe('the record: the rules replayed on what you decided', () => {
  it('agreements and disagreements per kind', () => {
    // a transfer booked as the rule would; one debit + payment booked as spending instead (disagrees);
    // a note marked seen; a receipt-explained debit booked in the evidence's category
    const d1 = ceft(25025, '2026-09-02 09:00', { transaction_id: 't1' });
    const p1 = pay(25000, '2026-09-02 09:02', { transaction_id: 't1' });
    const d2 = ceft(17025, '2026-09-16 09:00', { transaction_id: 't2' });
    const p2 = pay(17000, '2026-09-16 09:02', { transaction_id: 't3' });
    const note = sms({ kind: 'info', amount: 1, at: '2026-09-20 10:00', parser: 'peoples.statement', merchant_text: 'Statement', account_id: 'card', ignored: true });
    const d3 = ceft(198, '2026-10-20 18:21', { merchant_text: 'Online Transfer Debit', transaction_id: 't4' });
    const r = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog reload', ignored: true });
    const booked: BookedLite[] = [
      { sms_id: d1.id, transaction_id: 't1', type: 'transfer', account_id: 'boc', to_account_id: 'card', source: 'sms', category_id: null },
      { sms_id: p1.id, transaction_id: 't1', type: 'transfer', account_id: 'boc', to_account_id: 'card', source: 'sms', category_id: null },
      { sms_id: d2.id, transaction_id: 't2', type: 'expense', account_id: 'boc', to_account_id: null, source: 'sms', category_id: C.fees },
      { sms_id: p2.id, transaction_id: 't3', type: 'transfer', account_id: 'boc', to_account_id: 'card', source: 'sms', category_id: null },
      { sms_id: d3.id, transaction_id: 't4', type: 'expense', account_id: 'boc', to_account_id: null, source: 'sms', category_id: C.mobile },
    ];
    const rec = autobookRecord({ sms: [d1, p1, d2, p2, note, d3, r], accounts, categories, memory: new Map(), payees: new Map(), booked, candidates: [] });
    expect(rec.alert_transfer).toEqual({ right: 1, of: 2 });
    expect(rec.alert_note).toEqual({ right: 2, of: 2 });
    expect(rec.category_evidence).toEqual({ right: 1, of: 1 });
  });
});
