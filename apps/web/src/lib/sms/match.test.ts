import { describe, expect, it } from 'vitest';
import { analyseInbox, postFingerprint, type AccountLite, type SmsRow, type TxCandidate } from './match';

const accounts: AccountLite[] = [
  { id: 'cash', kind: 'cash', is_suspense: false, archived: false, credit_limit: null },
  { id: 'boc', kind: 'bank', is_suspense: false, archived: false, credit_limit: null },
  { id: 'bocCard', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 250000 },
  { id: 'seylan', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 100000 },
  { id: 'peoples', kind: 'credit_card', is_suspense: false, archived: false, credit_limit: 1000000 },
  { id: 'match', kind: 'credit_card', is_suspense: true, archived: false, credit_limit: null },
];

let n = 0;
function sms(p: Partial<SmsRow> & Pick<SmsRow, 'kind' | 'account_id' | 'amount' | 'received_at'>): SmsRow {
  n++;
  const on = new Date(Date.parse(p.received_at) + 5.5 * 3600e3).toISOString();
  return {
    id: `s${n}`, sender: 'X', body: '', fingerprint: `s${n}`, institution: null, last_digits: null, currency: 'LKR',
    balance_after: null, merchant_text: null, occurred_on: on.slice(0, 10), occurred_at: on.slice(11, 19),
    transaction_id: null, ignored: false, ...p,
  };
}

function tx(p: Partial<TxCandidate> & Pick<TxCandidate, 'id' | 'type' | 'account_id' | 'total' | 'occurred_on'>): TxCandidate {
  return { to_account_id: null, payee_text: null, occurred_at: null, ...p };
}

describe('linking alerts to bills already in the ledger', () => {
  it('a card charge matches a scanned bill waiting in "to be matched" and moves it', () => {
    const s = sms({ kind: 'card_charge', account_id: 'seylan', amount: 4520, received_at: '2026-09-03T13:36:00Z' });
    const bill = tx({ id: 't1', type: 'expense', account_id: 'match', total: 4520, occurred_on: '2026-09-03', occurred_at: '19:05:00' });
    const other = tx({ id: 't2', type: 'expense', account_id: 'match', total: 4520, occurred_on: '2026-08-10' });
    const { suggestions } = analyseInbox([s], [bill, other], new Set(), accounts);
    expect(suggestions.get(s.id)).toEqual({ kind: 'link', txId: 't1', confident: true, moves: true, others: [] });
  });
  it('two same-amount bills on the same day: suggested, but not confident', () => {
    const s = sms({ kind: 'card_charge', account_id: 'seylan', amount: 595, received_at: '2026-09-03T08:00:00Z' });
    const a = tx({ id: 'a', type: 'expense', account_id: 'match', total: 595, occurred_on: '2026-09-03', occurred_at: '13:00:00' });
    const b = tx({ id: 'b', type: 'expense', account_id: 'match', total: 595, occurred_on: '2026-09-03', occurred_at: '14:00:00' });
    const sug = analyseInbox([s], [a, b], new Set(), accounts).suggestions.get(s.id);
    expect(sug).toMatchObject({ kind: 'link', txId: 'a', confident: false, others: ['b'] });
  });
  it('a bill already linked to another alert is not offered again', () => {
    const s = sms({ kind: 'card_charge', account_id: 'seylan', amount: 595, received_at: '2026-09-03T08:00:00Z' });
    const a = tx({ id: 'a', type: 'expense', account_id: 'match', total: 595, occurred_on: '2026-09-03' });
    const sug = analyseInbox([s], [a], new Set(['a']), accounts).suggestions.get(s.id);
    expect(sug).toEqual({ kind: 'expense', account: 'seylan', total: 595, estimated: false });
  });
  it("another card's bill is not a match", () => {
    const s = sms({ kind: 'card_charge', account_id: 'seylan', amount: 595, received_at: '2026-09-03T08:00:00Z' });
    const a = tx({ id: 'a', type: 'expense', account_id: 'bocCard', total: 595, occurred_on: '2026-09-03' });
    expect(analyseInbox([s], [a], new Set(), accounts).suggestions.get(s.id)?.kind).toBe('expense');
  });
});

describe('transfers', () => {
  it('BOC CEFT debit + card payment (same minute) = transfer with the Rs 25 fee', () => {
    const d = sms({ kind: 'bank_debit', account_id: 'boc', amount: 25025, received_at: '2026-08-25T13:01:10Z' });
    const p = sms({ kind: 'card_payment', account_id: 'seylan', amount: 25000, received_at: '2026-08-25T13:00:30Z' });
    const { suggestions } = analyseInbox([d, p], [], new Set(), accounts);
    expect(suggestions.get(d.id)).toEqual({
      kind: 'transfer', from: 'boc', to: 'seylan', total: 25000, fee: 25, pairId: p.id, confident: true,
    });
    expect(suggestions.get(p.id)).toMatchObject({ kind: 'transfer', pairId: d.id });
  });
  it("People's payment 3 hours BEFORE the BOC debit still pairs", () => {
    const p = sms({ kind: 'card_payment', account_id: 'peoples', amount: 35000, received_at: '2026-09-15T16:12:00Z' });
    const d = sms({ kind: 'bank_debit', account_id: 'boc', amount: 35025, received_at: '2026-09-15T19:11:00Z' });
    expect(analyseInbox([p, d], [], new Set(), accounts).suggestions.get(d.id)).toMatchObject({ kind: 'transfer', fee: 25 });
  });
  it('each debit pairs with at most one payment (the closest)', () => {
    const d = sms({ kind: 'bank_debit', account_id: 'boc', amount: 25025, received_at: '2026-08-25T13:00:00Z' });
    const near = sms({ kind: 'card_payment', account_id: 'seylan', amount: 25000, received_at: '2026-08-25T13:01:00Z' });
    const far = sms({ kind: 'card_payment', account_id: 'peoples', amount: 25000, received_at: '2026-08-26T10:00:00Z' });
    const { suggestions } = analyseInbox([d, near, far], [], new Set(), accounts);
    expect(suggestions.get(d.id)).toMatchObject({ pairId: near.id });
    expect(suggestions.get(far.id)).toMatchObject({ kind: 'transfer', from: 'boc', to: 'peoples', confident: false });
  });
  it('ATM withdrawal = BOC → Cash', () => {
    const s = sms({ kind: 'atm', account_id: 'boc', amount: 10000, received_at: '2026-09-21T12:10:00Z' });
    expect(analyseInbox([s], [], new Set(), accounts).suggestions.get(s.id)).toMatchObject({
      kind: 'transfer', from: 'boc', to: 'cash', total: 10000, fee: 0,
    });
  });
  it('a transfer typed in by hand is linked, not duplicated', () => {
    const s = sms({ kind: 'bank_debit', account_id: 'boc', amount: 5025, received_at: '2026-09-10T04:00:00Z' });
    const t = tx({ id: 'manual', type: 'transfer', account_id: 'boc', to_account_id: 'seylan', total: 5000, occurred_on: '2026-09-10' });
    expect(analyseInbox([s], [t], new Set(), accounts).suggestions.get(s.id)).toMatchObject({ kind: 'link', txId: 'manual' });
  });
});

describe('balances', () => {
  it('a USD charge gets its rupee cost from the drop in available credit', () => {
    const before = sms({ kind: 'card_charge', account_id: 'bocCard', amount: 1000, balance_after: 31000, received_at: '2026-09-09T10:00:00Z', transaction_id: 'x' });
    const usd = sms({ kind: 'card_charge', account_id: 'bocCard', amount: 4.73, currency: 'USD', balance_after: 29605.28, received_at: '2026-09-10T02:12:00Z' });
    const { lkr, suggestions } = analyseInbox([before, usd], [], new Set(), accounts);
    expect(lkr.get(usd.id)).toEqual({ amount: 1394.72, estimated: true });
    expect(suggestions.get(usd.id)).toEqual({ kind: 'expense', account: 'bocCard', total: 1394.72, estimated: true });
  });
  it('flags a missed alert when the running balance jumps', () => {
    const a = sms({ kind: 'bank_debit', account_id: 'boc', amount: 198, balance_after: 16243.81, received_at: '2026-09-05T06:00:00Z' });
    const b = sms({ kind: 'bank_debit', account_id: 'boc', amount: 100, balance_after: 15000, received_at: '2026-09-06T06:00:00Z' });
    const c = sms({ kind: 'bank_credit', account_id: 'boc', amount: 1000, balance_after: 16000, received_at: '2026-09-07T06:00:00Z' });
    const { gaps } = analyseInbox([a, b, c], [], new Set(), accounts);
    expect(gaps.get(b.id)).toEqual({ expected: 16143.81, reported: 15000 });
    expect(gaps.has(c.id)).toBe(false);
  });
});

it('the post fingerprint is the earliest alert, like the database', () => {
  expect(postFingerprint([
    { received_at: '2026-08-25T13:01:10+00:00', fingerprint: 'sb' },
    { received_at: '2026-08-25T13:00:30+00:00', fingerprint: 'sz' },
  ])).toBe('sz');
});
