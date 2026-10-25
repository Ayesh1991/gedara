import { describe, expect, it } from 'vitest';
import { parseSms, type ParsedSms } from '@sms/parse';
import { unknownAccounts, type SmsRow } from '@match/sms';

// Phases 9b.1–9b.2: the payees' confirmations and BOC Flex Tap & Pay, read field by field.
const at = '2026-10-22T08:12:00Z'; // 13:42 Colombo

function parsed(sender: string, body: string): ParsedSms {
  const v = parseSms({ sender, body, receivedAt: at });
  if (!v.keep) throw new Error(`dropped (${v.reason}): ${body}`);
  return v.sms;
}

describe('BOC Flex Tap & Pay (BOCONLINE)', () => {
  it('a payment from the wallet, with its shop and reference', () => {
    expect(parsed('BOCONLINE',
      'Your Tap & Pay transaction of LKR 2252.00 from XXXX3399 at GUNASEKARA & COMPANY was successful. Ref: VC_7760QQS8'))
      .toMatchObject({
        parser: 'boconline.tap_pay', kind: 'bank_debit', institution: 'BOC Flex', last_digits: '3399', amount: 2252, currency: 'LKR',
        merchant_text: 'GUNASEKARA & COMPANY', bank_txn_id: 'VC_7760QQS8', occurred_on: '2026-10-22', occurred_at: '13:42:00',
      });
    expect(parsed('BOCONLINE',
      'Your Tap & Pay transaction of LKR 1480.00 from XXXX3399 at CARGILLS - KURANA was successful. Ref: VC_8805TAX8'))
      .toMatchObject({ merchant_text: 'CARGILLS - KURANA', amount: 1480 });
  });

  it('money sent to the wallet is money in', () => {
    expect(parsed('BOCONLINE', 'Hey there, You have received LKR 5,000.00. from DR (MRS) D M D PERERA.'))
      .toMatchObject({ parser: 'boconline.received', kind: 'bank_credit', institution: 'BOC Flex', amount: 5000, merchant_text: 'DR (MRS) D M D PERERA' });
  });

  it('its OTPs never get through', () => {
    for (const body of [
      'BOC Flex Fund Transfer - LKR 320,000.00. Please use OTP 610068 to authorize the Transaction. Do not share this OTP with anyone.',
      'BOC Flex Save New Payee - Please use OTP 002909 to save the payee. Do not share this OTP with anyone.',
      'Dear user, please use OTP for limit change: 850359. Do not share this OTP with anyone.',
    ]) {
      expect(parseSms({ sender: 'BOCONLINE', body, receivedAt: at })).toEqual({ keep: false, reason: 'otp' });
    }
  });

  it('"New account seen" offers the wallet as a wallet', () => {
    const s = parsed('BOCONLINE',
      'Your Tap & Pay transaction of LKR 2252.00 from XXXX3399 at GUNASEKARA & COMPANY was successful. Ref: VC_7760QQS8');
    const row = { ...s, id: 'w1', account_id: null, transaction_id: null, ignored: false } as unknown as SmsRow;
    expect(unknownAccounts([row])).toEqual([{ institution: 'BOC Flex', digits: '3399', kind: 'wallet', count: 1 }]);
  });
});

describe('payees (9b.1)', () => {
  it('SLT, LECO, Mobitel, Dialog and Star Points confirmations', () => {
    expect(parsed('SLTBILL', 'Your bill payment Rs.3400.00 has been received to account number 0034847977 (94113602084) on 2026/09/22:02:34:51 AM. Thank you.'))
      .toMatchObject({ kind: 'receipt', parser: 'slt.bill', amount: 3400, merchant_text: 'SLT bill', occurred_on: '2026-09-22' });
    expect(parsed('Star Points', 'Dear Customer, you have earned 1.98 Star Points for the Dialog Mobile reload of Rs. 198.00/- made on 20/10/2026 18:20:50. Total Star Points balance: 598.91. Visit the MyDialog App https://md.dialog.lk/spsms or dial #141# to check on Star Points offers.'))
      .toMatchObject({ kind: 'receipt', amount: 198, merchant_text: 'Dialog reload', occurred_on: '2026-10-20', occurred_at: '18:20:50' });
    expect(parsed('Star Points', 'Dear Customer, you have earned 1.6 Star Points for your transaction at Cargills Rewards on 2026/10/20 21:10:25. Total Star Points balance is 205.35'))
      .toMatchObject({ kind: 'info', parser: 'starpoints.shop', amount: null, merchant_text: 'Cargills' });
  });
});
