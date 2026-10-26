import { describe, expect, it, vi } from 'vitest';
import { payeeCategory } from '@match/memory';
import { bookedTwice, checkPastBookings, duplicateAlerts, runEval, runMatching, walletTopups, type BookedRow, type Bundle } from '@match/run';
import { analyseInbox, namesNoShop, paymentEvidence, type SmsRow } from '@match/sms';

// Phase 9b.1: evidence before guesses. A payee's confirmation (Dialog, SLT, LECO, Star Points) explains a
// bank debit; your past choices are a weak hint; alerts that name no shop never go to the AI; past bookings
// the evidence contradicts are listed for a person to check.

const C = {
  services: 'c-serv', mobile: 'c-mob', internet: 'c-net', fees: 'c-fees', energy: 'c-ener', electric: 'c-elec',
  grocery: 'c-groc', otherGrocery: 'c-ogroc', other: 'c-oth', misc: 'c-misc',
};
const cat = (id: string, parent_id: string | null, key: string | null, name: string) =>
  ({ id, parent_id, key, name, kind: 'expense', default_destiny: 'expense', archived: false });
const categories = [
  cat(C.services, null, 'services', 'Services'),
  cat(C.mobile, C.services, null, 'Mobile & telephone'),
  cat(C.internet, C.services, null, 'Internet'),
  cat(C.fees, C.services, null, 'Banking & fees'),
  cat(C.energy, null, 'energy', 'Energy'),
  cat(C.electric, C.energy, null, 'Electricity'),
  cat(C.grocery, null, 'grocery', 'Grocery'),
  cat(C.otherGrocery, C.grocery, null, 'Other grocery'),
  cat(C.other, null, 'other', 'Other'),
  cat(C.misc, C.other, null, 'Miscellaneous'),
];

const accounts = [
  { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null },
  { id: 'peoples', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 1000000 },
  { id: 'match', kind: 'credit_card', is_suspense: true, archived: false, credit_limit: null },
];

let n = 0;
/** at: Colombo wall-clock "yyyy-mm-dd hh:mm" */
function sms(p: Partial<SmsRow> & Pick<SmsRow, 'kind' | 'amount'> & { at: string }): SmsRow {
  n++;
  const [on, hm] = p.at.split(' ') as [string, string];
  const rest: Partial<SmsRow> & Pick<SmsRow, 'kind' | 'amount'> & { at?: string } = { ...p };
  delete rest.at;
  return {
    id: `s${n}`, sender: 'X', body: '', fingerprint: `f${n}`, institution: null, last_digits: null, account_id: null, currency: 'LKR',
    balance_after: null, merchant_text: null, bank_txn_id: null, parser: null, occurred_on: on, occurred_at: `${hm}:00`,
    received_at: new Date(Date.parse(`${on}T${hm}:00+05:30`)).toISOString(), transaction_id: null, ignored: false, ...rest,
  };
}
const ceft = (amount: number, at: string, p: Partial<SmsRow> = {}) =>
  sms({ kind: 'bank_debit', amount, at, account_id: 'boc', merchant_text: 'CEFT Transfer Debit', parser: 'boc.debit', ...p });
const booked = (s: SmsRow, p: Partial<BookedRow> & Pick<BookedRow, 'transaction_id' | 'type'>): BookedRow => ({
  sms_id: s.id, account_id: s.account_id ?? 'boc', to_account_id: null, total: s.amount ?? 0, source: 'sms', lines: 1,
  line_id: `l-${p.transaction_id}`, category_id: null, has_fee: false, ...p,
});

function bundle(p: Partial<Bundle> = {}): Bundle {
  return {
    settings: { ai_enabled: true, monthly_cap_usd: 3, daily_requests: 150 },
    usage: { month_cost_usd: 0, today: {} },
    accounts, categories, products: [], aliases: [], held: [], merchant_memory: [], line_memory: [], suggestions: [],
    ...p,
  };
}
const KEYS = { groq: 'g', gemini: 'm', openai: 'o' };
const noAi = () => vi.fn(async () => new Response('{}', { status: 500 }));

describe('evidence: a payee confirms a payment', () => {
  it('a Dialog receipt explains the BOC debit of the same amount; the receipt becomes its note', () => {
    const debit = ceft(198, '2026-10-20 18:21', { merchant_text: 'Online Transfer Debit' });
    const receipt = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog reload', parser: 'starpoints.reload' });
    const { suggestions } = analyseInbox([debit, receipt], [], new Set(), accounts);
    expect(suggestions.get(debit.id)).toMatchObject({ kind: 'expense', evidence: 'Dialog reload', memo: 'Dialog reload' });
    expect(suggestions.get(receipt.id)).toEqual({ kind: 'note', reason: 'receipt', relatedSmsId: debit.id, confident: true });
  });

  it('a bank fee on top (SLT Rs 3,400 paid by a Rs 3,425 CEFT) still counts; one payment per receipt', () => {
    const a = ceft(3425, '2026-09-22 08:30');
    const b = ceft(3425, '2026-09-25 08:30');
    const slt = sms({ kind: 'receipt', amount: 3400, at: '2026-09-22 08:34', merchant_text: 'SLT bill', parser: 'slt.bill' });
    const ev = paymentEvidence([a, b, slt]);
    expect(ev.get(a.id)).toEqual({ payee: 'SLT bill', fromSmsId: slt.id, fee: 25 });
    expect(ev.has(b.id)).toBe(false);
  });

  it('too far apart, or a smaller payment, is no evidence; a Star Points shop note pairs within 30 minutes', () => {
    const late = ceft(672, '2026-10-01 09:00');
    const work = sms({ kind: 'receipt', amount: 672, at: '2026-10-03 09:00', merchant_text: 'Dialog plan' });
    const small = ceft(500, '2026-10-10 10:00');
    const leco = sms({ kind: 'receipt', amount: 600, at: '2026-10-10 10:05', merchant_text: 'LECO electricity' });
    const card = sms({ kind: 'card_charge', amount: 4520, at: '2026-10-20 21:10', account_id: 'peoples', merchant_text: 'CARGILLS FOOD CITY' });
    const shop = sms({ kind: 'info', amount: null, at: '2026-10-20 21:10', merchant_text: 'Cargills', parser: 'starpoints.shop' });
    const ev = paymentEvidence([late, work, small, leco, card, shop]);
    expect(ev.has(late.id)).toBe(false);
    expect(ev.has(small.id)).toBe(false);
    expect(ev.get(card.id)).toMatchObject({ payee: 'Cargills', fromSmsId: shop.id });
  });

  it('a Star Points shop note never explains a payment elsewhere (fuel, a transfer) at the same time', () => {
    const fuel = sms({ kind: 'card_charge', amount: 10350, at: '2026-10-07 18:05', account_id: 'peoples', merchant_text: 'NW LOGISTICS AND MANAGEMECOLOMBO 05 LK' });
    const transfer = ceft(50000, '2026-10-07 18:10', { merchant_text: 'Online Transfer Debit' });
    const shop = sms({ kind: 'info', amount: null, at: '2026-10-07 18:00', merchant_text: 'Cargills', parser: 'starpoints.shop' });
    expect(paymentEvidence([fuel, transfer, shop]).size).toBe(0);
  });

  it('payees map to categories; the household’s own choice wins', () => {
    expect(payeeCategory(categories, new Map(), 'SLT bill')).toBe(C.internet);
    expect(payeeCategory(categories, new Map(), 'Mobitel recharge')).toBe(C.mobile);
    expect(payeeCategory(categories, new Map(), 'Dialog reload')).toBe(C.mobile);
    expect(payeeCategory(categories, new Map(), 'LECO electricity')).toBe(C.electric);
    expect(payeeCategory(categories, new Map(), 'Cargills')).toBe(C.otherGrocery);
    expect(payeeCategory(categories, new Map(), 'Somebody')).toBeNull();
    expect(payeeCategory(categories, new Map([['slt bill', C.mobile]]), 'SLT bill')).toBe(C.mobile);
  });

  it('bank wording that names no shop is recognised', () => {
    expect(namesNoShop('CEFT Transfer Debit')).toBe(true);
    expect(namesNoShop('Online Transfer Debit')).toBe(true);
    expect(namesNoShop(null)).toBe(true);
    expect(namesNoShop('KEELLS SUPER')).toBe(false);
  });
});

describe('runMatching: evidence first, past choices weak, no-shop alerts never to the AI', () => {
  it('evidence sets the category (0.98) and asks no AI', async () => {
    const debit = ceft(198, '2026-10-20 18:21', { merchant_text: 'Online Transfer Debit' });
    const receipt = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog reload' });
    const ai = noAi();
    const out = await runMatching(bundle({ sms: [debit, receipt] }), { keys: KEYS, fetchImpl: ai });
    expect(out.suggestions.find((s) => s.target_key === debit.id)).toMatchObject({
      task: 'sms_category', pattern: 'evidence', confidence: 0.98, proposal: { category_id: C.mobile, evidence: 'Dialog reload' },
    });
    expect(ai).not.toHaveBeenCalled();
  });

  it('a no-shop alert without evidence: not to the AI, and one remembered choice is not enough', async () => {
    const debit = ceft(25025, '2026-10-20 10:00');
    const ai = noAi();
    const out = await runMatching(bundle({
      sms: [debit], merchant_memory: [{ merchant_norm: 'ceft transfer debit', category_id: C.fees, account_id: null }],
    }), { keys: KEYS, fetchImpl: ai });
    expect(ai).not.toHaveBeenCalled();
    expect(out.suggestions).toEqual([]);
  });

  it('a suggestion whose reason is gone goes stale (old "Cargills" evidence on a Rs 50,000 transfer)', async () => {
    const debit = ceft(50000, '2026-10-21 18:00', { merchant_text: 'Online Transfer Debit' });
    const out = await runMatching(bundle({
      sms: [debit], suggestions: [{ task: 'sms_category', target_key: debit.id, input_hash: 'hold', status: 'pending' }],
    }), { keys: KEYS, fetchImpl: noAi() });
    expect(out.stale).toEqual([{ task: 'sms_category', target_key: debit.id }]);
  });

  it('three agreeing past choices (±5 %) are a hint at 0.7; a disagreeing one cancels it', async () => {
    const past = [ceft(2000, '2026-08-01 10:00'), ceft(2050, '2026-08-15 10:00'), ceft(1980, '2026-09-01 10:00')]
      .map((s, i) => ({ ...s, transaction_id: `t${i}` }));
    const rows = past.map((s, i) => booked(s, { transaction_id: `t${i}`, type: 'expense', category_id: C.misc }));
    const debit = ceft(2010, '2026-10-01 10:00');
    const ai = noAi();
    const out = await runMatching(bundle({ sms: [...past, debit], booked: rows }), { keys: KEYS, fetchImpl: ai });
    expect(out.suggestions.find((s) => s.target_key === debit.id)).toMatchObject({
      pattern: 'history', confidence: 0.7, proposal: { category_id: C.misc, past: 3 },
    });
    const other = ceft(2000, '2026-09-10 10:00', { transaction_id: 't9' });
    const out2 = await runMatching(bundle({
      sms: [...past, other, debit], booked: [...rows, booked(other, { transaction_id: 't9', type: 'expense', category_id: C.fees })],
    }), { keys: KEYS, fetchImpl: ai });
    expect(out2.suggestions.find((s) => s.target_key === debit.id)).toBeUndefined();
    expect(ai).not.toHaveBeenCalled();
  });
});

describe('Check past bookings', () => {
  it('CEFT Rs 25,025 booked as an expense + the card payment booked as a transfer → join it, Rs 25 fee', () => {
    const debit = ceft(25025, '2026-10-05 09:00', { transaction_id: 'tx-exp' });
    const pay = sms({ kind: 'card_payment', amount: 25000, at: '2026-10-05 15:00', account_id: 'peoples', transaction_id: 'tx-tr' });
    const out = checkPastBookings(bundle({
      booked: [
        booked(debit, { transaction_id: 'tx-exp', type: 'expense', category_id: C.fees }),
        booked(pay, { transaction_id: 'tx-tr', type: 'transfer', account_id: 'match', to_account_id: 'peoples', lines: 0, line_id: null }),
      ],
    }), [debit, pay], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      task: 'sms_rebook', target_key: debit.id, sms_id: debit.id, pattern: 'evidence',
      proposal: { debit_sms: debit.id, delete_tx: ['tx-exp'], transfer_id: 'tx-tr', to_account_id: null, payment_sms: null, total: 25000, fee: 25, fee_category_id: C.fees },
    });
  });

  it('the card payment still waiting → a new transfer with both alerts; a payment booked as an expense goes too', () => {
    const debit = ceft(17025, '2026-10-06 09:00', { transaction_id: 'tx-a' });
    const pay = sms({ kind: 'card_payment', amount: 17000, at: '2026-10-07 08:00', account_id: 'peoples' });
    const out = checkPastBookings(bundle({ booked: [booked(debit, { transaction_id: 'tx-a', type: 'expense', category_id: C.fees })] }),
      [debit, pay], new Map());
    expect(out[0]!.proposal).toMatchObject({ delete_tx: ['tx-a'], transfer_id: null, to_account_id: 'peoples', payment_sms: pay.id, fee: 25 });

    const debit2 = ceft(5025, '2026-10-08 09:00', { transaction_id: 'tx-b' });
    const pay2 = sms({ kind: 'card_payment', amount: 5000, at: '2026-10-08 10:00', account_id: 'peoples', transaction_id: 'tx-c' });
    const out2 = checkPastBookings(bundle({
      booked: [booked(debit2, { transaction_id: 'tx-b', type: 'expense' }), booked(pay2, { transaction_id: 'tx-c', type: 'income', account_id: 'peoples' })],
    }), [debit2, pay2], new Map());
    expect(out2[0]!.proposal).toMatchObject({ delete_tx: ['tx-b', 'tx-c'], to_account_id: 'peoples', payment_sms: pay2.id });
  });

  it('no card payment within 48 h, a transfer that already has its bank side, or a shop debit → nothing', () => {
    const debit = ceft(30000, '2026-10-01 09:00', { transaction_id: 'tx-1' });
    const far = sms({ kind: 'card_payment', amount: 30000, at: '2026-10-04 09:00', account_id: 'peoples' });
    const debit2 = ceft(15025, '2026-10-10 09:00', { transaction_id: 'tx-2' });
    const pay2 = sms({ kind: 'card_payment', amount: 15000, at: '2026-10-10 10:00', account_id: 'peoples', transaction_id: 'tx-3' });
    const side = ceft(15000, '2026-10-10 09:30', { transaction_id: 'tx-3' });
    const shop = ceft(9025, '2026-10-12 09:00', { transaction_id: 'tx-4', merchant_text: 'KEELLS SUPER' });
    const pay4 = sms({ kind: 'card_payment', amount: 9000, at: '2026-10-12 10:00', account_id: 'peoples' });
    const out = checkPastBookings(bundle({
      booked: [
        booked(debit, { transaction_id: 'tx-1', type: 'expense' }), booked(debit2, { transaction_id: 'tx-2', type: 'expense' }),
        booked(pay2, { transaction_id: 'tx-3', type: 'transfer', lines: 0 }), booked(side, { transaction_id: 'tx-3', type: 'transfer', lines: 0 }),
        booked(shop, { transaction_id: 'tx-4', type: 'expense' }),
      ],
    }), [debit, far, debit2, pay2, side, shop, pay4], new Map());
    expect(out).toEqual([]);
  });

  it('a booked category the receipt disagrees with → recategorise the line', () => {
    const debit = ceft(198, '2026-10-20 18:21', { transaction_id: 'tx-d' });
    const receipt = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog plan' });
    const out = checkPastBookings(bundle({ booked: [booked(debit, { transaction_id: 'tx-d', type: 'expense', category_id: C.fees })] }),
      [debit, receipt], new Map());
    expect(out).toEqual([expect.objectContaining({
      task: 'sms_recategorise', target_key: debit.id, line_id: 'l-tx-d',
      proposal: expect.objectContaining({ category_id: C.mobile, was_category_id: C.fees, payee: 'Dialog plan', receipt_sms: receipt.id }),
    })]);
    // already right → nothing
    expect(checkPastBookings(bundle({ booked: [booked(debit, { transaction_id: 'tx-d', type: 'expense', category_id: C.mobile })] }),
      [debit, receipt], new Map())).toEqual([]);
  });

  it('the same main category is no contradiction (Grocery vs Grocery › Other grocery)', () => {
    const card = sms({ kind: 'card_charge', amount: 1950, at: '2026-08-25 10:00', account_id: 'peoples', merchant_text: 'CARGILLS FOODCITY RAJAGIRIYA', transaction_id: 'tx-g' });
    const shop = sms({ kind: 'info', amount: null, at: '2026-08-25 10:01', merchant_text: 'Cargills', parser: 'starpoints.shop' });
    expect(checkPastBookings(bundle({ booked: [booked(card, { transaction_id: 'tx-g', type: 'expense', category_id: C.grocery })] }),
      [card, shop], new Map())).toEqual([]);
  });

  it('runMatching saves the audit once and leaves a decided one alone', async () => {
    const debit = ceft(198, '2026-10-20 18:21', { transaction_id: 'tx-d' });
    const receipt = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog plan' });
    const b = bundle({ sms: [debit, receipt], booked: [booked(debit, { transaction_id: 'tx-d', type: 'expense', category_id: C.fees })] });
    const first = await runMatching(b, { keys: KEYS, fetchImpl: noAi() });
    const audit = first.suggestions.find((s) => s.task === 'sms_recategorise')!;
    expect(audit).toBeDefined();
    const again = await runMatching({ ...b, suggestions: [{ task: audit.task, target_key: audit.target_key, input_hash: audit.input_hash, status: 'rejected' }] },
      { keys: KEYS, fetchImpl: noAi() });
    expect(again.suggestions.find((s) => s.task === 'sms_recategorise')).toBeUndefined();
    expect(again.stale).toEqual([]);
  });
});

describe('the accuracy test is honest', () => {
  it('evidence confirms or contradicts a past choice; no-shop alerts are counted, never asked', async () => {
    const dialog = ceft(198, '2026-10-20 18:21', { transaction_id: 'tx-1' });
    const r1 = sms({ kind: 'receipt', amount: 198, at: '2026-10-20 18:20', merchant_text: 'Dialog plan' });
    const slt = ceft(3400, '2026-09-22 08:30', { transaction_id: 'tx-2' });
    const r2 = sms({ kind: 'receipt', amount: 3400, at: '2026-09-22 08:34', merchant_text: 'SLT bill' });
    const blank = ceft(30000, '2026-10-01 09:00', { transaction_id: 'tx-3' });
    const ai = noAi();
    const out = await runEval(bundle({
      sms: [dialog, r1, slt, r2, blank],
      eval_sms: [
        { id: dialog.id, merchant_text: 'CEFT Transfer Debit', amount: 198, kind: 'bank_debit', category_id: C.fees },
        { id: slt.id, merchant_text: 'CEFT Transfer Debit', amount: 3400, kind: 'bank_debit', category_id: C.internet },
        { id: blank.id, merchant_text: 'CEFT Transfer Debit', amount: 30000, kind: 'bank_debit', category_id: C.fees },
      ],
    }), { keys: KEYS, fetchImpl: ai });
    expect(ai).not.toHaveBeenCalled();
    const by = (id: string) => out.evals.find((e) => e.target_key === id)!;
    expect(by(dialog.id)).toMatchObject({ truth: { contradicted: true, category_id: C.mobile, chosen: C.fees }, rule_correct: null, ai_correct: null });
    expect(by(slt.id)).toMatchObject({ truth: { evidence: true }, rule_correct: true });
    expect(by(blank.id)).toMatchObject({ truth: { no_shop: true }, rule_correct: null, ai_correct: null });
    expect(out.remaining).toBe(0);
  });
});

describe('BOC Flex wallet top-ups (9b.2): no SMS, so the bank balance tells', () => {
  const withWallet = (p: Partial<Bundle> = {}) => bundle({
    accounts: [
      { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
      { id: 'wallet', kind: 'wallet', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC Flex' },
    ],
    ...p,
  });
  // the wallet in use: a Tap & Pay payment
  const tap = sms({ kind: 'bank_debit', amount: 1480, at: '2026-10-21 12:00', account_id: 'wallet', merchant_text: 'CARGILLS - KURANA', parser: 'boconline.tap_pay' });
  const boc = (amount: number, at: string, balance: number) => ceft(amount, at, { balance_after: balance, merchant_text: 'ATM Withdrawal' });

  it('a BOC balance that dropped Rs 5,000 more than its alerts explain → a top-up of the wallet', () => {
    const a = boc(1000, '2026-10-20 09:00', 50000);
    const b = boc(2000, '2026-10-22 09:00', 43000);
    const c = boc(1000, '2026-10-23 09:00', 42000);
    const out = walletTopups(withWallet(), [a, tap, b, c]);
    expect(out).toEqual([expect.objectContaining({
      task: 'sms_topup', target_key: b.id, confidence: 0.7, pattern: 'balance',
      proposal: expect.objectContaining({ from_account_id: 'boc', to_account_id: 'wallet', total: 5000, since: '2026-10-20', occurred_on: '2026-10-22' }),
    })]);
  });

  it('an ATM fee next to it does not hide a top-up', () => {
    const a = boc(1000, '2026-10-19 09:00', 51005);
    const fee = boc(1000, '2026-10-20 09:00', 50000); // Rs 5 ATM fee: off by 5
    const b = boc(2000, '2026-10-22 09:00', 43000);
    expect(walletTopups(withWallet(), [a, fee, tap, b]).map((t) => t.proposal.total)).toEqual([5000]);
  });

  it('not a top-up: the Rs 5 ATM fee, a transfer + fee whose alert is missing, alerts out of order, before the wallet', () => {
    const fee = [boc(1000, '2026-10-20 09:00', 50000), boc(1000, '2026-10-21 09:00', 48995)];
    expect(walletTopups(withWallet(), [...fee, tap])).toEqual([]);
    const ceftFee = [boc(1000, '2026-10-20 09:00', 50000), boc(1000, '2026-10-22 09:00', 23975)];
    expect(walletTopups(withWallet(), [...ceftFee, tap])).toEqual([]);
    // −98,892.60 then +78,897.60: two alerts swapped, not money that left
    const swapped = [boc(1000, '2026-10-08 09:00', 108331.93), boc(30000, '2026-10-10 09:00', 177219.53), boc(5000, '2026-10-10 10:00', 93300)];
    expect(walletTopups(withWallet(), [...swapped, tap])).toEqual([]);
    const early = [boc(1000, '2026-07-01 09:00', 50000), boc(1000, '2026-07-03 09:00', 44000)];
    expect(walletTopups(withWallet(), [...early, tap])).toEqual([]);
  });

  it('nothing when it is already booked, when money came in, or without exactly one wallet', () => {
    const a = boc(1000, '2026-10-20 09:00', 50000);
    const b = boc(2000, '2026-10-22 09:00', 43000);
    const topup = { id: 't', type: 'transfer', account_id: 'boc', to_account_id: 'wallet', payee_text: null, occurred_on: '2026-10-21', occurred_at: null, total: 5000 };
    expect(walletTopups(withWallet({ candidates: [topup] }), [a, tap, b])).toEqual([]);
    const up = boc(2000, '2026-10-22 09:00', 53000);
    expect(walletTopups(withWallet(), [a, tap, up])).toEqual([]);
    expect(walletTopups(bundle(), [a, tap, b])).toEqual([]);
  });
});

describe('Paid from the other account, and the same alert twice (9b.2 fix)', () => {
  const twoBanks = (p: Partial<Bundle> = {}) => bundle({
    accounts: [
      { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
      { id: 'boc708', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
      { id: 'sampath', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 300000, institution: 'Sampath' },
    ],
    ...p,
  });

  it("a card payment booked from Savings with no debit, while ··708's CEFT Rs 50,025 waits → move it there", () => {
    const pay = sms({ kind: 'card_payment', amount: 50000, at: '2026-10-14 10:00', account_id: 'sampath', sender: 'SAMPCCTXN', transaction_id: 'tx-p' });
    const debit = ceft(50025, '2026-10-15 09:00', { account_id: 'boc708' });
    const out = checkPastBookings(twoBanks({
      booked: [booked(pay, { transaction_id: 'tx-p', type: 'transfer', account_id: 'boc', to_account_id: 'sampath', total: 50000, lines: 0, line_id: null })],
    }), [pay, debit], new Map());
    expect(out).toEqual([expect.objectContaining({
      task: 'sms_rebook', target_key: debit.id,
      proposal: expect.objectContaining({ debit_sms: debit.id, delete_tx: [], transfer_id: 'tx-p', total: 50000, fee: 25, moved: true, was_account_id: 'boc', from_account_id: 'boc708' }),
    })]);
  });

  it('a transfer that already has its debit, or a debit too far away, is left alone', () => {
    const pay = sms({ kind: 'card_payment', amount: 50000, at: '2026-10-14 10:00', account_id: 'sampath', transaction_id: 'tx-p' });
    const own = ceft(50025, '2026-10-14 09:59', { account_id: 'boc', transaction_id: 'tx-p' });
    const waiting = ceft(50025, '2026-10-15 09:00', { account_id: 'boc708' });
    const b = booked(pay, { transaction_id: 'tx-p', type: 'transfer', account_id: 'boc', to_account_id: 'sampath', total: 50000, lines: 0, line_id: null });
    expect(checkPastBookings(twoBanks({ booked: [b, booked(own, { transaction_id: 'tx-p', type: 'transfer', lines: 0, line_id: null })] }), [pay, own, waiting], new Map())).toEqual([]);
    const far = ceft(50025, '2026-10-20 09:00', { account_id: 'boc708' });
    expect(checkPastBookings(twoBanks({ booked: [b] }), [pay, far], new Map())).toEqual([]);
  });

  it('the same alert twice (same sender, kind, amount, balance) booked as its own entry → remove that entry', () => {
    const first = sms({ kind: 'card_payment', amount: 25000, balance_after: 50328.7, at: '2026-10-02 01:12', account_id: 'sampath', sender: 'SAMPCCTXN', transaction_id: 'tx-1' });
    const copy = sms({ kind: 'card_payment', amount: 25000, balance_after: 50328.7, at: '2026-10-02 01:12', account_id: 'sampath', sender: 'SAMPCCTXN', transaction_id: 'tx-2' });
    expect(duplicateAlerts([first, copy])).toEqual([expect.objectContaining({
      task: 'sms_duplicate', target_key: copy.id, proposal: expect.objectContaining({ keep_sms: [first.id], drop_sms: [copy.id], delete_tx: 'tx-2' }),
    })]);
  });

  it('a whole copied transfer (debit + card alert, re-imported later) goes as one; a waiting copy is only marked seen', () => {
    const d1 = ceft(20000, '2026-09-28 23:16', { balance_after: 177219.53, transaction_id: 'tx-a' });
    const c1 = sms({ kind: 'card_payment', amount: 20000, balance_after: 38298.09, at: '2026-09-28 23:17', account_id: 'sampath', transaction_id: 'tx-a' });
    const d2 = ceft(20000, '2026-10-10 12:00', { balance_after: 177219.53, transaction_id: 'tx-b' });
    const c2 = sms({ kind: 'card_payment', amount: 20000, balance_after: 38298.09, at: '2026-10-10 12:00', account_id: 'sampath', transaction_id: 'tx-b' });
    const out = duplicateAlerts([d1, c1, d2, c2]);
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal).toMatchObject({ delete_tx: 'tx-b', keep_sms: expect.arrayContaining([d1.id, c1.id]), drop_sms: expect.arrayContaining([d2.id, c2.id]) });
    const w = ceft(20000, '2026-10-10 12:00', { balance_after: 177219.53 });
    expect(duplicateAlerts([d1, w])[0]!.proposal).toMatchObject({ delete_tx: null, drop_sms: [w.id] });
  });

  it('not a copy: a different balance, more than a month apart, or the original still waiting', () => {
    const a = ceft(5000, '2026-10-01 10:00', { balance_after: 10000, transaction_id: 'tx-1' });
    expect(duplicateAlerts([a, ceft(5000, '2026-10-01 11:00', { balance_after: 5000, transaction_id: 'tx-2' })])).toEqual([]);
    expect(duplicateAlerts([a, ceft(5000, '2026-11-15 10:00', { balance_after: 10000, transaction_id: 'tx-3' })])).toEqual([]);
    const waiting = ceft(5000, '2026-10-01 10:00', { balance_after: 10000 });
    expect(duplicateAlerts([waiting, ceft(5000, '2026-10-02 10:00', { balance_after: 10000, transaction_id: 'tx-4' })])).toEqual([]);
  });

  it('a Star Points shop note explains a Cargills payment but never sets or changes its category', () => {
    const card = sms({ kind: 'card_charge', amount: 4170.75, at: '2026-05-23 18:00', account_id: 'peoples', merchant_text: 'CARGILLS - RAJAGIRIYA', transaction_id: 'tx-c' });
    const shop = sms({ kind: 'info', amount: null, at: '2026-05-23 18:01', merchant_text: 'Cargills', parser: 'starpoints.shop' });
    expect(checkPastBookings(bundle({ booked: [booked(card, { transaction_id: 'tx-c', type: 'expense', category_id: C.misc })] }), [card, shop], new Map())).toEqual([]);
    const fresh = sms({ kind: 'card_charge', amount: 999, at: '2026-05-24 18:00', account_id: 'peoples', merchant_text: 'CARGILLS - RAJAGIRIYA' });
    const note = sms({ kind: 'info', amount: null, at: '2026-05-24 18:01', merchant_text: 'Cargills', parser: 'starpoints.shop' });
    const sug = analyseInbox([fresh, note], [], new Set(), accounts).suggestions.get(fresh.id);
    expect(sug).toMatchObject({ kind: 'expense', memo: 'CARGILLS - RAJAGIRIYA' });
    expect(sug).not.toHaveProperty('evidence');
  });
});

describe('Money moved between your own accounts (9b.2 fix)', () => {
  const banks = (p: Partial<Bundle> = {}) => bundle({
    accounts: [
      { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
      { id: 'boc708', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
      { id: 'peoples', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 1000000, institution: "People's" },
      { id: 'sampath', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 300000, institution: 'Sampath' },
    ],
    ...p,
  });
  const out708 = (amount: number, at: string, p: Partial<SmsRow> = {}) => ceft(amount, at, { account_id: 'boc708', merchant_text: 'Online Transfer Debit', ...p });
  const inSav = (amount: number, at: string, p: Partial<SmsRow> = {}) =>
    sms({ kind: 'bank_credit', amount, at, account_id: 'boc', merchant_text: 'Online Transfer Credit', ...p });

  it('both waiting: the inbox pairs a transfer debit and a transfer credit on your own accounts', () => {
    const d = out708(200000, '2026-10-14 10:00');
    const c = inSav(200000, '2026-10-14 10:01');
    const { suggestions } = analyseInbox([d, c], [], new Set(), banks().accounts);
    expect(suggestions.get(d.id)).toMatchObject({ kind: 'transfer', from: 'boc708', to: 'boc', total: 200000, fee: 0, pairId: c.id });
    // a salary deposit is no transfer
    const salary = sms({ kind: 'bank_credit', amount: 200000, at: '2026-10-14 10:02', account_id: 'boc', merchant_text: 'No Book Deposit S/A' });
    expect(analyseInbox([out708(200000, '2026-10-14 10:00'), salary], [], new Set(), banks().accounts).suggestions.get(salary.id)).toMatchObject({ kind: 'income' });
  });

  it('booked as spending on one side and income on the other → one transfer', () => {
    const d = out708(110000, '2026-10-21 09:00', { transaction_id: 'tx-e' });
    const c = inSav(110000, '2026-10-21 09:01', { transaction_id: 'tx-i' });
    const out = checkPastBookings(banks({
      booked: [booked(d, { transaction_id: 'tx-e', type: 'expense', account_id: 'boc708' }), booked(c, { transaction_id: 'tx-i', type: 'income', account_id: 'boc' })],
    }), [d, c], new Map());
    expect(out).toEqual([expect.objectContaining({
      task: 'sms_rebook', target_key: d.id,
      proposal: expect.objectContaining({ own: true, delete_tx: ['tx-e', 'tx-i'], transfer_id: null, to_account_id: 'boc', payment_sms: c.id, total: 110000, fee: 0 }),
    })]);
  });

  it('the nearest card payment already having its debit does not hide the next one', () => {
    const d = ceft(50025, '2026-10-15 09:00', { account_id: 'boc708', transaction_id: 'tx-d' });
    const near = sms({ kind: 'card_payment', amount: 50000, at: '2026-10-15 09:01', account_id: 'peoples', transaction_id: 'tx-p' });
    const own = ceft(50025, '2026-10-15 09:00', { account_id: 'boc', transaction_id: 'tx-p' });
    const far = sms({ kind: 'card_payment', amount: 50000, at: '2026-10-14 12:00', account_id: 'sampath', transaction_id: 'tx-s' });
    const out = checkPastBookings(banks({
      booked: [
        booked(d, { transaction_id: 'tx-d', type: 'expense', account_id: 'boc708' }),
        booked(near, { transaction_id: 'tx-p', type: 'transfer', account_id: 'boc', to_account_id: 'peoples', total: 50000, lines: 0, line_id: null }),
        booked(own, { transaction_id: 'tx-p', type: 'transfer', account_id: 'boc', lines: 0, line_id: null }),
        booked(far, { transaction_id: 'tx-s', type: 'transfer', account_id: 'boc', to_account_id: 'sampath', total: 50000, lines: 0, line_id: null }),
      ],
    }), [d, near, own, far], new Map());
    expect(out).toEqual([expect.objectContaining({ proposal: expect.objectContaining({ transfer_id: 'tx-s', delete_tx: ['tx-d'], fee: 25 }) })]);
  });
});

describe('Tap & Pay and its scanned bill (9b.2 fix)', () => {
  const withWallet = (p: Partial<Bundle> = {}) => bundle({
    accounts: [
      { id: 'wallet', kind: 'wallet', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC Flex' },
      { id: 'match', kind: 'credit_card', is_suspense: true, archived: false, credit_limit: null },
    ],
    ...p,
  });
  const tap = (amount: number, at: string, p: Partial<SmsRow> = {}) =>
    sms({ kind: 'bank_debit', amount, at, account_id: 'wallet', merchant_text: 'CARGILLS - RAJAGIRIYA', parser: 'boconline.tap_pay', ...p });
  const bill = (id: string, total: number, on: string) =>
    ({ id, type: 'expense', account_id: 'match', to_account_id: null, payee_text: 'CARGILLS FOOD CITY', occurred_on: on, occurred_at: '19:00:00', total });

  it('a waiting Tap & Pay alert links to the scanned bill in "to be matched" and moves it', () => {
    const s = tap(5066.26, '2026-10-25 19:05');
    const { suggestions } = analyseInbox([s], [bill('b1', 5066.26, '2026-10-25')], new Set(), withWallet().accounts);
    expect(suggestions.get(s.id)).toMatchObject({ kind: 'link', txId: 'b1', moves: true, confident: true });
  });

  it("booked from the alert while the bill waits → keep the bill, drop the alert's entry", () => {
    const s = tap(5066.26, '2026-10-25 19:05', { transaction_id: 'tx-a' });
    const b = withWallet({
      candidates: [bill('b1', 5066.26, '2026-10-25'), bill('b2', 5066.26, '2026-10-01')],
      booked: [booked(s, { transaction_id: 'tx-a', type: 'expense', account_id: 'wallet' })],
    });
    expect(bookedTwice(b, [s], new Map(b.booked!.map((r) => [r.sms_id, r])), new Set())).toEqual([expect.objectContaining({
      task: 'sms_relink', target_key: s.id, proposal: expect.objectContaining({ sms_ids: [s.id], delete_tx: 'tx-a', bill_tx: 'b1', total: 5066.26 }),
    })]);
  });

  it('also when the bill was already moved to the same account by hand', () => {
    const s = tap(2252, '2026-10-21 12:00', { transaction_id: 'tx-a' });
    const rows = [booked(s, { transaction_id: 'tx-a', type: 'expense', account_id: 'wallet' })];
    const onWallet = { ...bill('b1', 2252, '2026-10-21'), account_id: 'wallet' };
    const elsewhere = { ...bill('b2', 2252, '2026-10-21'), account_id: 'cash' };
    expect(bookedTwice(withWallet({ candidates: [elsewhere, onWallet], booked: rows }), [s], new Map(rows.map((r) => [r.sms_id, r])), new Set()))
      .toEqual([expect.objectContaining({ proposal: expect.objectContaining({ bill_tx: 'b1', delete_tx: 'tx-a' }) })]);
  });

  it('not when the bill is already linked, the amount differs, or it is days apart', () => {
    const s = tap(2252, '2026-10-21 12:00', { transaction_id: 'tx-a' });
    const rows = [booked(s, { transaction_id: 'tx-a', type: 'expense', account_id: 'wallet' })];
    const bySms = new Map(rows.map((r) => [r.sms_id, r]));
    expect(bookedTwice(withWallet({ candidates: [bill('b1', 2252, '2026-10-21')], linked: ['b1'], booked: rows }), [s], bySms, new Set())).toEqual([]);
    expect(bookedTwice(withWallet({ candidates: [bill('b1', 2250, '2026-10-21')], booked: rows }), [s], bySms, new Set())).toEqual([]);
    expect(bookedTwice(withWallet({ candidates: [bill('b1', 2252, '2026-10-26')], booked: rows }), [s], bySms, new Set())).toEqual([]);
  });
});
