import { describe, expect, it } from 'vitest';
import { parseScanText } from '@scan/schema.ts';
import { alreadyIn, parseRow, resolveDayLabel, screenshotRows, toBackup, type InboxFacts } from './screenshot';

// The BOC thread Didula screenshotted on Sunday 2026-09-27 (22:55), as the Bill Scanner copies it.
const FILE = JSON.stringify({
  doc_type: 'bank_sms',
  sender: 'BOC',
  captured_on: '2026-09-27',
  messages: [
    {
      sender: 'BOC',
      day_label: 'Friday',
      time: '04:45',
      body: 'No Book Deposit S/A Rs 289927.72 To A/C No XXXXXXXXXX319. Balance available Rs 292471.53 - Thank you for banking with BOC',
    },
    {
      day_label: 'Friday',
      time: '13:11',
      body: 'ATM Withdrawal Rs 10000.00 From A/C No XXXXXXXXXX319. Balance available Rs 282466.53 - Thank you for banking with BOC',
    },
    {
      day_label: 'Yesterday',
      time: '15:05',
      body: 'CEFT Transfer Debit Rs 7025.00 From A/C No XXXXXXXXXX319. Balance available Rs 275441.53 - Thank you for banking with BOC',
    },
  ],
});

describe('bank SMS screenshots (Phase 7c)', () => {
  it('the scanner JSON validates as one bank_sms document', () => {
    const r = parseScanText(FILE);
    expect('kind' in r && r.kind).toBe('bank_sms');
  });

  it('day labels count back from the capture day', () => {
    expect(resolveDayLabel('Today', '2026-09-27')).toBe('2026-09-27');
    expect(resolveDayLabel('Yesterday', '2026-09-27')).toBe('2026-09-26');
    expect(resolveDayLabel('Friday', '2026-09-27')).toBe('2026-09-25');
    expect(resolveDayLabel('Mon', '2026-09-27')).toBe('2026-09-21');
    expect(resolveDayLabel('12 Sep', '2026-09-27')).toBe('2026-09-12');
    expect(resolveDayLabel('Sep 30', '2026-09-27')).toBe('2025-09-30');
    expect(resolveDayLabel('Fri, 5 Sept 2025', '2026-09-27')).toBe('2025-09-05');
    expect(resolveDayLabel('someday', '2026-09-27')).toBeNull();
  });

  it('rows get their day; without a capture date every day is a guess', () => {
    const r = parseScanText(FILE);
    if (!('kind' in r) || r.kind !== 'bank_sms') throw new Error('not bank_sms');
    const rows = screenshotRows(r.docs, new Date('2026-09-28T03:00:00Z'));
    expect(rows.map((x) => [x.sender, x.date, x.time, x.guessed])).toEqual([
      ['BOC', '2026-09-25', '04:45', false],
      ['BOC', '2026-09-25', '13:11', false],
      ['BOC', '2026-09-26', '15:05', false],
    ]);
    const noCapture = screenshotRows([{ ...r.docs[0]!, captured_on: null }], new Date('2026-09-27T17:30:00Z'));
    expect(noCapture.every((x) => x.guessed)).toBe(true);
    expect(noCapture[2]!.date).toBe('2026-09-26');
    expect(toBackup(rows[1]!)).toEqual({ sender: 'BOC', body: rows[1]!.body, receivedAt: Date.parse('2026-09-25T13:11:00+05:30') });
  });

  it('parses like a forwarded alert and knows which ones already arrived', () => {
    const r = parseScanText(FILE);
    if (!('kind' in r) || r.kind !== 'bank_sms') throw new Error('not bank_sms');
    const rows = screenshotRows(r.docs, new Date());
    const parsed = rows.map(parseRow);
    const sms = parsed.map((p) => ('sms' in p ? p.sms : null));
    expect(sms.map((s) => [s?.kind, s?.amount, s?.balance_after, s?.last_digits])).toEqual([
      ['bank_credit', 289927.72, 292471.53, '319'],
      ['atm', 10000, 282466.53, '319'],
      ['bank_debit', 7025, 275441.53, '319'],
    ]);
    // The forwarder did deliver the CEFT alert (a few seconds off, text with an extra space).
    const inbox: InboxFacts[] = [
      { institution: 'BOC', amount: 7025, balance_after: 275441.53, last_digits: '319', received_at: '2026-09-26T09:35:07Z' },
    ];
    expect(sms.map((s) => alreadyIn(s!, inbox))).toEqual([false, false, true]);
  });

  it('an OTP in a screenshot is never kept', () => {
    const p = parseRow({ key: 'x', sender: 'BOC', body: 'Your OTP is 123456. Do not share it.', date: '2026-09-27', time: '10:00', guessed: false });
    expect(p).toEqual({ reason: 'otp' });
  });
});
