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
    balance_after: null, merchant_text: null, bank_txn_id: null, parser: null, occurred_on: on.slice(0, 10), occurred_at: on.slice(11, 19),
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
    expect(sug).toEqual({ kind: 'expense', account: 'seylan', total: 595, estimated: false, memo: null });
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
    expect(suggestions.get(usd.id)).toEqual({ kind: 'expense', account: 'bocCard', total: 1394.72, estimated: true, memo: null });
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

describe('Phase 9a: new accounts, loan, refunds, notes, ETC', () => {
  const withLoans: AccountLite[] = [
    ...accounts.map((a) => (a.id === 'boc' ? { ...a, institution: 'BOC' } : a)),
    { id: 'boc708', kind: 'bank', is_suspense: false, archived: false, credit_limit: null, institution: 'BOC' },
  ];

  it('groups waiting alerts for digits no account has, as a bank or a card', () => {
    const rows = [
      sms({ kind: 'bank_debit', account_id: null, amount: 1000, received_at: '2026-10-15T07:00:00Z', institution: 'BOC', last_digits: '708' }),
      sms({ kind: 'bank_debit', account_id: null, amount: 2000, received_at: '2026-10-15T08:00:00Z', institution: 'BOC', last_digits: '708' }),
      sms({ kind: 'card_charge', account_id: null, amount: 50, received_at: '2026-10-15T09:00:00Z', institution: 'Sampath', last_digits: '1111' }),
      sms({ kind: 'bank_debit', account_id: null, amount: 3000, received_at: '2026-10-15T10:00:00Z', institution: 'BOC', last_digits: '708', ignored: true }),
      sms({ kind: 'info', account_id: null, amount: 99, received_at: '2026-10-15T11:00:00Z', institution: "People's", last_digits: '1913' }),
    ];
    expect(analyseInbox(rows, [], new Set(), accounts).unknownAccounts).toEqual([
      { institution: 'BOC', digits: '708', kind: 'bank', count: 2 },
      { institution: 'Sampath', digits: '1111', kind: 'credit_card', count: 1 },
    ]);
  });

  it('a large Transfer Order Credit is a loan, never income', () => {
    const s = sms({ kind: 'bank_credit', account_id: 'boc708', amount: 2_000_000, merchant_text: 'Transfer Order Credit', received_at: '2026-10-14T03:30:00Z' });
    expect(analyseInbox([s], [], new Set(), withLoans).suggestions.get(s.id)).toEqual({ kind: 'loan', account: 'boc708', total: 2_000_000, loanAccount: null });
    const loan: AccountLite = { id: 'loan', kind: 'loan', is_suspense: false, archived: false, credit_limit: 2_000_000, institution: 'BOC' };
    expect(analyseInbox([s], [], new Set(), [...withLoans, loan]).suggestions.get(s.id)).toMatchObject({ kind: 'loan', loanAccount: 'loan' });
    const salary = sms({ kind: 'bank_credit', account_id: 'boc', amount: 283927.32, merchant_text: 'No Book Deposit S/A', received_at: '2026-09-25T03:30:00Z' });
    expect(analyseInbox([salary], [], new Set(), withLoans).suggestions.get(salary.id)).toMatchObject({ kind: 'income' });
  });

  it('the 708 account paying a card is a transfer pair like the savings account', () => {
    const d = sms({ kind: 'bank_debit', account_id: 'boc708', amount: 190354.7, received_at: '2026-10-14T17:40:30Z' });
    const p = sms({ kind: 'card_payment', account_id: 'bocCard', amount: 190354.7, received_at: '2026-10-14T18:57:18Z' });
    expect(analyseInbox([d, p], [], new Set(), withLoans).suggestions.get(d.id)).toMatchObject({
      kind: 'transfer', from: 'boc708', to: 'bocCard', fee: 0, pairId: p.id, confident: true,
    });
  });

  it('a Seylan reversal is a refund that finds its charge by the bank id', () => {
    const charge = sms({ kind: 'card_charge', account_id: 'seylan', amount: 6.15, currency: 'USD', bank_txn_id: '10063001165', received_at: '2026-06-09T02:28:19Z', transaction_id: 'tx-temu' });
    const rev = sms({ kind: 'refund', account_id: 'seylan', amount: 6.15, currency: 'USD', bank_txn_id: 'R10063001165', received_at: '2026-06-09T02:40:00Z' });
    expect(analyseInbox([charge, rev], [], new Set(['tx-temu']), accounts).suggestions.get(rev.id)).toMatchObject({
      kind: 'refund', account: 'seylan', chargeTxId: 'tx-temu', chargeSmsId: charge.id, confident: true,
    });
    const hold = sms({ kind: 'refund', account_id: 'seylan', amount: 2, bank_txn_id: 'R10459616070', received_at: '2026-10-14T07:18:04Z' });
    expect(analyseInbox([hold], [], new Set(), accounts).suggestions.get(hold.id)).toMatchObject({ kind: 'refund', chargeSmsId: null, confident: false });
  });

  it("notes move no money; an instalment plan points at the purchase it converts", () => {
    const charge = sms({ kind: 'card_charge', account_id: 'peoples', amount: 123456, institution: "People's", received_at: '2026-07-18T05:00:00Z' });
    const plan = sms({ kind: 'info', parser: 'peoples.instalment', account_id: null, amount: 123456, institution: "People's", received_at: '2026-07-20T05:00:00Z' });
    const stmt = sms({ kind: 'info', parser: 'peoples.statement', account_id: 'peoples', amount: 99999, received_at: '2026-10-02T05:00:00Z' });
    const { suggestions } = analyseInbox([charge, plan, stmt], [], new Set(), accounts);
    expect(suggestions.get(plan.id)).toEqual({ kind: 'note', reason: 'instalment', relatedSmsId: charge.id, confident: true });
    expect(suggestions.get(stmt.id)).toEqual({ kind: 'note', reason: 'statement', relatedSmsId: null, confident: true });
    expect(suggestions.get(charge.id)).toMatchObject({ kind: 'expense' });
  });

  it('an ETC top-up seen twice is one expense: the bank debit, filed under tolls', () => {
    const etc = sms({ kind: 'bank_debit', parser: 'boc.etc_topup', account_id: null, amount: 25000, merchant_text: 'ETC top-up', received_at: '2026-04-28T14:42:47Z' });
    const debit = sms({ kind: 'bank_debit', account_id: 'boc', amount: 25000, merchant_text: 'Online Transfer Debit', received_at: '2026-04-28T14:42:01Z' });
    const { suggestions } = analyseInbox([etc, debit], [], new Set(), withLoans);
    expect(suggestions.get(etc.id)).toEqual({ kind: 'note', reason: 'same_as', relatedSmsId: debit.id, confident: true });
    expect(suggestions.get(debit.id)).toMatchObject({ kind: 'expense', account: 'boc', memo: 'ETC top-up' });
    // alone: an expense from a BOC account the alert doesn't name (two BOC accounts → pick, not confident)
    const lone = sms({ kind: 'bank_debit', parser: 'boc.etc_topup', account_id: null, amount: 1000, merchant_text: 'ETC top-up', received_at: '2026-05-20T15:24:22Z' });
    expect(analyseInbox([lone], [], new Set(), withLoans).suggestions.get(lone.id)).toMatchObject({ kind: 'expense', memo: 'ETC top-up', total: 1000 });
  });
});
