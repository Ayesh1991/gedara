import { describe, expect, it } from 'vitest';
import { hash32 as ledgerHash } from '@/lib/money/fingerprint';
import { FORWARD_TEXT_REGEX, hash32, parseSms, smsFingerprint, type ParsedSms } from '@sms/parse';

// Real alert wording (amounts real, account numbers already masked by the banks). Received times are
// Colombo local (+05:30) written as UTC.
const at = (colombo: string) => new Date(`${colombo}+05:30`).toISOString();

function kept(sender: string, body: string, received: string): ParsedSms {
  const v = parseSms({ sender, body, receivedAt: at(received) });
  if (!v.keep) throw new Error(`dropped: ${v.reason}`);
  return v.sms;
}

describe('BOC (savings ..319 and credit card ..8873 share one sender)', () => {
  it('CEFT transfer debit', () => {
    const s = kept('BOC',
      'CEFT Transfer Debit Rs 50025.00 From A/C No XXXXXXXXXX319. Balance available Rs 16441.81 - Thank you for banking with BOC',
      '2026-09-05T10:15:00');
    expect(s).toMatchObject({
      parser: 'boc.account_bank_debit', kind: 'bank_debit', institution: 'BOC', last_digits: '319', amount: 50025,
      currency: 'LKR', balance_after: 16441.81, merchant_text: 'CEFT Transfer Debit',
      occurred_on: '2026-09-05', occurred_at: '10:15:00',
    });
  });
  it('online transfer with a shorter mask', () => {
    const s = kept('BOC',
      'Online Transfer Debit Rs 198.00 From A/C No XXXXX319. Balance available Rs 16243.81 - Thank you for banking with BOC',
      '2026-09-05T11:00:00');
    expect(s).toMatchObject({ kind: 'bank_debit', last_digits: '319', amount: 198, balance_after: 16243.81 });
  });
  it('deposit (money in)', () => {
    const s = kept('BOC',
      'No Book Deposit S/A Rs 283927.32 To A/C No XXXXXXXXXX319. Balance available Rs 285125.92 - Thank you for banking with BOC',
      '2026-09-20T08:00:00');
    expect(s).toMatchObject({ kind: 'bank_credit', amount: 283927.32, balance_after: 285125.92 });
  });
  it('ATM withdrawal', () => {
    const s = kept('BOC',
      'ATM Withdrawal Rs 10000.00 From A/C No XXXXXXXXXX319. Balance available Rs 250095.92 - Thank you for banking with BOC',
      '2026-09-21T17:40:00');
    expect(s).toMatchObject({ kind: 'atm', amount: 10000, balance_after: 250095.92 });
  });
  it('credit-card purchase in USD', () => {
    const s = kept('BOC',
      'Purchase. Transaction approved on your Credit Card 5524 **** **** 8873 for USD 4.73 at SUPABASE SINGAPORE. Balance Available LKR 29605.28',
      '2026-09-10T02:12:00');
    expect(s).toMatchObject({
      parser: 'boc.card_purchase', kind: 'card_charge', last_digits: '8873', currency: 'USD', amount: 4.73,
      merchant_text: 'SUPABASE SINGAPORE', balance_after: 29605.28,
    });
  });
});

describe('Sampath (SAMPCCTXN, card ..6577)', () => {
  it('card charge; the date has no year', () => {
    const s = kept('SAMPCCTXN',
      'Cr Crd no..**6577 Auth Pmt LKR 23,890.00 at COOL PLANET Avl Bal LKR 105,627.96 Enq Call 0112300604 - Sampath Bank 05-SEP',
      '2026-09-05T15:20:00');
    expect(s).toMatchObject({
      parser: 'sampath.charge', kind: 'card_charge', institution: 'Sampath', last_digits: '6577', amount: 23890,
      merchant_text: 'COOL PLANET', balance_after: 105627.96, occurred_on: '2026-09-05', occurred_at: '15:20:00',
    });
  });
  it('payment received', () => {
    const s = kept('SAMPCCTXN',
      'Cr Crd no..**6577 Credited LKR 25,000.00 for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 129,517.96 Enq Call 0112300604 - Sampath Bank 02-SEP',
      '2026-09-02T09:00:00');
    expect(s).toMatchObject({ kind: 'card_payment', amount: 25000, balance_after: 129517.96, occurred_on: '2026-09-02' });
  });
  it('a December alert read in January belongs to last year', () => {
    const s = kept('SAMPCCTXN',
      'Cr Crd no..**6577 Auth Pmt LKR 1,000.00 at KEELLS Avl Bal LKR 100,000.00 Enq Call 0112300604 - Sampath Bank 31-DEC',
      '2027-01-01T00:30:00');
    expect(s.occurred_on).toBe('2026-12-31');
    expect(s.occurred_at).toBeNull();
  });
});

describe("People's (PeoplesCard, card ..1913)", () => {
  it('card charge', () => {
    const s = kept('PeoplesCard',
      'Peoples Card X-X-X-1913 trxn LKR 93,228.00 @ OXFORD COLLEGE OF BUSI, COLOMBO 07. [Av.Bal: LKR 258,487.46]. Call Center Hotline 1961',
      '2026-09-08T12:00:00');
    expect(s).toMatchObject({
      parser: 'peoples.charge', kind: 'card_charge', institution: "People's", last_digits: '1913', amount: 93228,
      merchant_text: 'OXFORD COLLEGE OF BUSI, COLOMBO 07', balance_after: 258487.46,
    });
  });
  it('payment received (dated, no balance)', () => {
    const s = kept('PeoplesCard',
      'Peoples Card: [X-X-X-1913] Your Payment Received. Rs.35,000.00 on 15-Sep-2026. THANK YOU.',
      '2026-09-15T21:42:00');
    expect(s).toMatchObject({ kind: 'card_payment', amount: 35000, balance_after: null, occurred_on: '2026-09-15' });
  });
  it('promotions from the same sender are dropped', () => {
    const v = parseSms({
      sender: 'PeoplesCard',
      body: 'Enjoy 25% off at selected restaurants with your Peoples Card. STOP SMS?Send NOPROM to0777701961',
      receivedAt: at('2026-09-09T10:00:00'),
    });
    expect(v).toEqual({ keep: false, reason: 'promo' });
  });
});

describe('Seylan (card ..6029)', () => {
  it('card charge with a bank txn id and full timestamp', () => {
    const s = kept('Seylan Bank',
      'Seylan Card ...6029 debit Txn 10357428172 of LKR 550.00 done on 12/09/2026 01:09:29 PM at Google One 650-2530000 US. Avl bal 14,722.11',
      '2026-09-12T13:10:00');
    expect(s).toMatchObject({
      parser: 'seylan.charge', kind: 'card_charge', institution: 'Seylan', last_digits: '6029', bank_txn_id: '10357428172',
      amount: 550, occurred_on: '2026-09-12', occurred_at: '13:09:29', merchant_text: 'Google One 650-2530000 US',
      balance_after: 14722.11,
    });
  });
  it('messy merchant names are kept as printed', () => {
    const s = kept('Seylan Bank',
      'Seylan Card ...6029 debit Txn 10357000001 of LKR 4,520.00 done on 03/09/2026 07:05:10 PM at CARGILLS - RAJAGIRIYA 3 COLOMBO 01 LK. Avl bal 20,000.00',
      '2026-09-03T19:06:00');
    expect(s.merchant_text).toBe('CARGILLS - RAJAGIRIYA 3 COLOMBO 01 LK');
    expect(s.occurred_at).toBe('19:05:10');
  });
  it('payment received', () => {
    const s = kept('Seylan Bank',
      'Seylan Credit Card Services - Thank you for your payment of LKR 25,000.00 made to Card # ...6029 on 25/08/2026 06:30:18 PM. Avl bal 36,644.16',
      '2026-08-25T18:30:40');
    expect(s).toMatchObject({
      parser: 'seylan.payment', kind: 'card_payment', amount: 25000, occurred_on: '2026-08-25', occurred_at: '18:30:18',
      balance_after: 36644.16,
    });
  });
});

describe('filters', () => {
  it('drops senders that are not allow-listed', () => {
    expect(parseSms({ sender: 'Dialog', body: 'Rs 500 reload', receivedAt: at('2026-09-01T10:00:00') }))
      .toEqual({ keep: false, reason: 'sender' });
  });
  it('drops OTPs, even from an allow-listed sender', () => {
    for (const body of [
      'Your OTP for the online transfer is 482913. Do not share it with anyone.',
      '482913 is your One Time Password for Rs 25,000.00 transfer',
      'Your verification code is 1234',
    ]) {
      expect(parseSms({ sender: 'BOC', body, receivedAt: at('2026-09-01T10:00:00') })).toEqual({ keep: false, reason: 'otp' });
    }
  });
  it('keeps an unseen format from a known sender as "unknown" so it shows up for review', () => {
    const s = kept('BOC', 'Your Credit Card 5524 **** **** 8873 payment of LKR 12,000.00 has been received', '2026-09-01T10:00:00');
    expect(s).toMatchObject({ kind: 'unknown', parser: null, amount: 12000, currency: 'LKR', last_digits: '8873' });
  });
  it('drops texts with no amount', () => {
    expect(parseSms({ sender: 'BOC', body: 'Our branches are closed on Poya day', receivedAt: at('2026-09-01T10:00:00') }))
      .toEqual({ keep: false, reason: 'no_amount' });
  });
  it('the phone-side regex blocks what the server blocks', () => {
    const re = new RegExp(FORWARD_TEXT_REGEX.replace('(?is)', ''), 'is');
    expect(re.test('Your OTP is 123456')).toBe(false);
    expect(re.test('ATM Withdrawal Rs 10000.00 From A/C No XXXXXXXXXX319. Balance available Rs 1.00')).toBe(true);
  });
});

describe('fingerprints', () => {
  it('djb2 is byte-for-byte the ledger v7 hash', () => {
    for (const s of ['', 'abc', 'BOC|CEFT Transfer Debit Rs 50025.00|2026-09-05T04:45', 'සිංහල']) {
      expect(hash32(s)).toBe(ledgerHash(s));
    }
  });
  it('is stable, per minute, and starts with s', () => {
    const a = smsFingerprint('BOC', 'x', '2026-09-05T04:45:10.000Z');
    expect(a).toMatch(/^s[0-9a-z]+$/);
    expect(smsFingerprint('BOC', 'x', '2026-09-05T04:45:59.000Z')).toBe(a);
    expect(smsFingerprint('BOC', 'x', '2026-09-05T04:46:00.000Z')).not.toBe(a);
  });
});
