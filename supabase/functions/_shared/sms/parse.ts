// Bank / card SMS alerts → parsed rows for the review inbox (Phase 2b).
// Shared by the sms-ingest Edge Function (Deno) and the web app (SMS-backup preview, via the `@sms`
// alias), so it must stay plain TypeScript (no package imports; ./secret.ts only). Formats are Didula's real alerts
// (docs/sms-forwarder-setup.md lists them). Bump PARSER_VERSION when a parser's output changes.
//
// Safety: only allow-listed senders are parsed; OTP / PIN / promo texts are dropped before parsing
// and are never stored (the database drops OTP-looking text again). The OTP check lives in
// ./secret.ts (Phase 9) so the AI gateway uses exactly the same one.
//
// v2 (Phase 9): BOC card payments, ETC top-ups, People's instalment plans / reminders / statements,
// Seylan reversals, amounts written ".99". `info` = a note with no money of its own; `refund` = money
// back on a card.

import { isSecret } from './secret.ts';

export { FORWARD_TEXT_REGEX, isSecret, secretReason } from './secret.ts';

export const PARSER_VERSION = 5;

export type SmsKind =
  | 'card_charge' | 'card_payment' | 'bank_debit' | 'bank_credit' | 'atm' | 'refund' | 'info' | 'receipt' | 'unknown';

/** One SMS as the phone saw it. receivedAt = ISO timestamp (or epoch ms) of arrival. */
export interface RawSms {
  sender: string;
  body: string;
  receivedAt: string | number;
}

/** The row the inbox RPCs take (snake_case = the RPC payload). */
export interface ParsedSms {
  sender: string;
  body: string;
  received_at: string;
  fingerprint: string;
  parser: string | null;
  parser_version: number;
  kind: SmsKind;
  institution: string;
  last_digits: string | null;
  amount: number | null;
  currency: string;
  balance_after: number | null;
  merchant_text: string | null;
  bank_txn_id: string | null;
  occurred_on: string; // YYYY-MM-DD, Asia/Colombo
  occurred_at: string | null; // HH:MM:SS, Asia/Colombo
}

/** 'notice': a payee's message that confirms no payment (an ad, a low balance, a quota used up). */
export type DropReason = 'sender' | 'otp' | 'promo' | 'no_amount' | 'notice' | 'invalid';

export type SmsVerdict = { keep: true; sms: ParsedSms } | { keep: false; reason: DropReason };

// ── Senders ──────────────────────────────────────────────────────────────────
// Sender id (letters and digits only, upper case) → institution as written on `account.institution`.
const SENDERS: Record<string, string> = {
  BOC: 'BOC',
  SAMPCCTXN: 'Sampath',
  SAMPATHTXN: 'Sampath', // the Sampath bank account and fixed deposit (Phase 9b.1)
  BOCONLINE: 'BOC Flex', // BOC Flex: Tap & Pay from the wallet (Phase 9b.2); its OTPs are dropped like any
  PEOPLESCARD: "People's",
  SEYLANBANK: 'Seylan',
  SEYLAN: 'Seylan',
  // Payees' own confirmations (Phase 9b.1, kind `receipt`): they explain a bank / card payment, never
  // money of their own. Only what a receipt parser recognises is kept.
  SLTBILL: 'SLT',
  SLTMOBITEL: 'SLT-Mobitel',
  '5555': 'Dialog',
  STARPOINTS: 'Star Points',
  LECOBILL: 'LECO',
};
const RECEIPT_SENDERS = new Set(['SLTBILL', 'SLTMOBITEL', '5555', 'STARPOINTS', 'LECOBILL']);

/** The sender ids the phone should forward (for the forwarder's sender regex). */
export const FORWARD_SENDERS = [
  'BOC', 'BOCONLINE', 'SAMPCCTXN', 'SAMPATHTXN', 'PeoplesCard', 'Seylan Bank',
  'SLTBILL', 'SLT-Mobitel', 'SLTMobitel', '5555', 'Star Points', 'LECO BILL',
] as const;

/** Is this sender a payee that only confirms payments (SLT, Dialog, LECO …)? */
export function isReceiptSender(sender: string): boolean {
  return RECEIPT_SENDERS.has(senderKey(sender));
}

export function senderKey(sender: string): string {
  return sender.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Institution for an allow-listed sender, else null. */
export function institutionFor(sender: string): string | null {
  return SENDERS[senderKey(sender)] ?? null;
}

// ── Filters ──────────────────────────────────────────────────────────────────
const PROMO_RE =
  /NOPROM|STOP ?SMS|unsubscribe|\b\d{1,2}% ?(off|discount|cash ?back|savings?|bonus)\b|\benjoy\b.*\d{1,2}%|\boffer valid\b|\bexclusive for\b|#[a-z]{3,}/i;
const AMOUNT_RE = /\b(LKR|Rs\.?|USD|EUR|GBP|SGD|AUD|INR)\s?(?:\d[\d,]*(\.\d{1,2})?|\.\d{1,2})/i;

export function isPromo(body: string): boolean {
  return PROMO_RE.test(body);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Sri Lanka: UTC+05:30, no DST
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** djb2 over UTF-16 code units, unsigned base36 — identical to apps/web `hash32` (ledger v7). */
export function hash32(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** `s<hash>` of sender|body|received minute (UTC) — the inbox fingerprint. */
export function smsFingerprint(sender: string, body: string, receivedAtIso: string): string {
  return 's' + hash32(`${sender.trim()}|${body}|${receivedAtIso.slice(0, 16)}`);
}

/** "25,000.00" / "Rs.35,000.00" → 25000 (cents-rounded); null when not a number. */
export function parseMoney(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[,\s]/g, '').replace(/^(rs\.?|lkr)/i, '').replace(/\/=$/, '').replace(/\.$/, '');
  if (!/^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100) / 100;
}

function toIso(receivedAt: string | number): string | null {
  const d = new Date(typeof receivedAt === 'number' ? receivedAt : String(receivedAt));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Colombo local date + time of an instant. */
export function colomboParts(iso: string): { date: string; time: string } {
  const local = new Date(new Date(iso).getTime() + COLOMBO_OFFSET_MS).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 19) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "12/09/2026" (dd/mm/yyyy) → "2026-09-12". */
function dmy(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!m) return null;
  return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
}

/** "01:09:29 PM" → "13:09:29". */
function time12(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP])M$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[4]!.toUpperCase() === 'P') h += 12;
  return `${pad(h)}:${m[2]}:${m[3] ?? '00'}`;
}

/** "06:36:44" (24 h) → "06:36:44". */
function time24(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  return m && Number(m[1]) < 24 ? `${pad(Number(m[1]))}:${m[2]}:${m[3] ?? '00'}` : null;
}

/** "05" + "SEP" without a year: the year of arrival, or the one before when that would be later. */
function dayMonth(day: string, mon: string, receivedDate: string, year?: string): string | null {
  const month = MONTHS[mon.slice(0, 3).toUpperCase()];
  if (!month) return null;
  let y = year ? Number(year) : Number(receivedDate.slice(0, 4));
  let date = `${y}-${pad(month)}-${pad(Number(day))}`;
  if (!year && date > receivedDate) {
    y -= 1;
    date = `${y}-${pad(month)}-${pad(Number(day))}`;
  }
  return date;
}

function clean(text: string | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/[.,\s]+$/, '').trim();
  return t ? t.slice(0, 120) : null;
}

type Fields = Pick<
  ParsedSms,
  'kind' | 'last_digits' | 'amount' | 'currency' | 'balance_after' | 'merchant_text' | 'bank_txn_id'
> & { parser: string; occurred_on?: string | null; occurred_at?: string | null };

type Parser = (body: string, receivedDate: string) => Fields | null;

const N = '(\\d[\\d,]*(?:\\.\\d{1,2})?|\\.\\d{1,2})'; // an amount ("1,000.00", "25000", ".99")
const DMY = '(\\d{1,2}\\/\\d{1,2}\\/\\d{4})';
const T12 = '(\\d{1,2}:\\d{2}(?::\\d{2})?\\s*[AP]M)';

// ── BOC ──────────────────────────────────────────────────────────────────────
// "CEFT Transfer Debit Rs 50025.00 From A/C No XXXXXXXXXX319. Balance available Rs 16441.81 - …"
// "No Book Deposit S/A Rs 283927.32 To A/C No XXXXXXXXXX319. Balance available Rs 285125.92 - …"
// "ATM Withdrawal Rs 10000.00 From A/C No XXXXXXXXXX319. Balance available Rs 250095.92 - …"
const BOC_ACCOUNT_RE = new RegExp(
  `^(.+?)\\s+Rs\\.?\\s*${N}\\s+(From|To)\\s+A\\/C No\\.?\\s*[X*x]*(\\d{3,4})\\.?\\s*Balance available Rs\\.?\\s*${N}`,
  'i',
);
// "Purchase. Transaction approved on your Credit Card 5524 **** **** 8873 for USD 4.73 at SUPABASE
//  SINGAPORE. Balance Available LKR 29605.28"
const BOC_CARD_RE = new RegExp(
  `Transaction approved on your Credit Card [\\d* ]*?(\\d{4})\\s+for\\s+([A-Z]{3})\\s*${N}\\s+at\\s+(.+?)\\.?\\s*Balance Available (?:LKR|Rs\\.?)\\s*${N}`,
  'i',
);

// "Dear Customer, Thank you for payment of LKR 25000.00 on 28/04/2026 for Credit Card no. 5524 **** ****
//  8873. Balance Available LKR 54605.28" (the first four digits are the card's bank prefix, not the card)
const BOC_CARD_PAYMENT_RE = new RegExp(
  `Thank you for payment of\\s+(?:LKR|Rs\\.?)\\s*${N}\\s+on\\s+${DMY}\\s+for Credit Card no\\.?\\s*[\\d* ]*?(\\d{4})\\.?\\s*Balance Available (?:LKR|Rs\\.?)\\s*${N}`,
  'i',
);
// "ETC A/C 1234567 Successfully topup through Internet Banking by Rs. 1000.00" (expressway E-tag; the
// tag's own number is not a bank account, so no digits are kept)
const BOC_ETC_TOPUP_RE = new RegExp(`^ETC A\\/C\\s*\\d+\\s+Successfully top-?up through (.+?) by\\s+Rs\\.?\\s*${N}`, 'i');
// "ETC A/C 1234567 Balance dropped to Rs.512.00, below the threshold limit. …"
const BOC_ETC_LOW_RE = new RegExp(`^ETC A\\/C\\s*\\d+\\s+Balance dropped to\\s+Rs\\.?\\s*${N}`, 'i');

const boc: Parser = (body) => {
  let m = BOC_CARD_PAYMENT_RE.exec(body);
  if (m) {
    return {
      parser: 'boc.card_payment', kind: 'card_payment', last_digits: m[3]!, currency: 'LKR', amount: parseMoney(m[1]),
      merchant_text: 'Payment received', balance_after: parseMoney(m[4]), bank_txn_id: null, occurred_on: dmy(m[2]!),
    };
  }
  m = BOC_ETC_TOPUP_RE.exec(body);
  if (m) {
    return {
      parser: 'boc.etc_topup', kind: 'bank_debit', last_digits: null, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: 'ETC top-up', balance_after: null, bank_txn_id: null,
    };
  }
  m = BOC_ETC_LOW_RE.exec(body);
  if (m) {
    return {
      parser: 'boc.etc_low', kind: 'info', last_digits: null, currency: 'LKR', amount: parseMoney(m[1]),
      merchant_text: 'ETC balance low', balance_after: parseMoney(m[1]), bank_txn_id: null,
    };
  }
  m = BOC_CARD_RE.exec(body);
  if (m) {
    return {
      parser: 'boc.card_purchase', kind: 'card_charge', last_digits: m[1]!, currency: m[2]!.toUpperCase(),
      amount: parseMoney(m[3]), merchant_text: clean(m[4]), balance_after: parseMoney(m[5]), bank_txn_id: null,
    };
  }
  m = BOC_ACCOUNT_RE.exec(body);
  if (m) {
    const desc = clean(m[1]);
    const out = m[3]!.toLowerCase() === 'from';
    const kind: SmsKind = /\bATM\b/i.test(m[1]!) ? 'atm' : out ? 'bank_debit' : 'bank_credit';
    return {
      parser: `boc.account_${kind}`, kind, last_digits: m[4]!, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: desc, balance_after: parseMoney(m[5]), bank_txn_id: null,
    };
  }
  return null;
};

// ── Sampath (SAMPCCTXN) ──────────────────────────────────────────────────────
// "Cr Crd no..**6577 Auth Pmt LKR 23,890.00 at COOL PLANET Avl Bal LKR 105,627.96 Enq Call … 05-SEP"
// "Cr Crd no..**6577 Credited LKR 25,000.00 for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR … 02-SEP"
const SAMPATH_CHARGE_RE = new RegExp(
  `Cr Crd no[.\\s]*\\**(\\d{4})\\s+Auth Pmt\\s+([A-Z]{3})\\s*${N}\\s+at\\s+(.+?)\\s+Avl Bal\\s+(?:LKR|Rs\\.?)\\s*${N}`,
  'i',
);
const SAMPATH_CREDIT_RE = new RegExp(
  `Cr Crd no[.\\s]*\\**(\\d{4})\\s+Credited\\s+([A-Z]{3})\\s*${N}\\s+for\\s+(.+?)\\s+Avl Bal\\s+(?:LKR|Rs\\.?)\\s*${N}`,
  'i',
);
const TRAILING_DAY_MON = /(\d{1,2})-([A-Z]{3})\s*$/i;

const sampath: Parser = (body, receivedDate) => {
  const dm = TRAILING_DAY_MON.exec(body);
  const occurredOn = dm ? dayMonth(dm[1]!, dm[2]!, receivedDate) : null;
  let m = SAMPATH_CHARGE_RE.exec(body);
  if (m) {
    return {
      parser: 'sampath.charge', kind: 'card_charge', last_digits: m[1]!, currency: m[2]!.toUpperCase(),
      amount: parseMoney(m[3]), merchant_text: clean(m[4]), balance_after: parseMoney(m[5]), bank_txn_id: null,
      occurred_on: occurredOn,
    };
  }
  m = SAMPATH_CREDIT_RE.exec(body);
  if (m) {
    const payment = /PAYMENT/i.test(m[4]!);
    return {
      parser: payment ? 'sampath.payment' : 'sampath.credit', kind: payment ? 'card_payment' : 'unknown',
      last_digits: m[1]!, currency: m[2]!.toUpperCase(), amount: parseMoney(m[3]), merchant_text: clean(m[4]),
      balance_after: parseMoney(m[5]), bank_txn_id: null, occurred_on: occurredOn,
    };
  }
  return null;
};

// ── People's (PeoplesCard) ───────────────────────────────────────────────────
// "Peoples Card X-X-X-1913 trxn LKR 93,228.00 @ OXFORD COLLEGE OF BUSI, COLOMBO 07. [Av.Bal: LKR 258,487.46]. …"
// "Peoples Card: [X-X-X-1913] Your Payment Received. Rs.35,000.00 on 15-Sep-2026. THANK YOU."
const PEOPLES_CHARGE_RE = new RegExp(
  `Peoples Card:?\\s*\\[?X-X-X-(\\d{4})\\]?\\s+trxn\\s+([A-Z]{3})\\s*${N}\\s*@\\s*(.+?)\\s*\\[Av\\.?\\s*Bal:?\\s*(?:LKR|Rs\\.?)\\s*${N}\\]`,
  'i',
);
const PEOPLES_PAYMENT_RE = new RegExp(
  `Peoples Card:?\\s*\\[?X-X-X-(\\d{4})\\]?\\s*Your Payment Received\\.?\\s*(?:Rs\\.?|LKR)\\s*${N}\\s+on\\s+(\\d{1,2})-([A-Za-z]{3})-(\\d{4})`,
  'i',
);

// Notes with no money of their own (kind `info`):
// "Dear Card Holder, 12-months instalment plan for LKR 123,456.00/= transaction at SRI LANKA INSURANCE
//  CORPO successfully created. Hotline 1961." — the purchase was already counted when it was charged.
const PEOPLES_INSTALMENT_RE = new RegExp(
  `(\\d{1,3})-months? instal+ment plan for\\s+(?:LKR|Rs\\.?)\\s*${N}(?:\\/=)?\\s+transaction at\\s+(.+?)\\s+successfully created`,
  'i',
);
// "Peoples Card: Stmt Summary [X-X-X-1913] Stmt.Date: 02-Oct-2026 Stmt.Bal: Rs.123,456.78 Min Pay: …"
const PEOPLES_STATEMENT_RE = new RegExp(
  `Stmt Summary\\s*\\[X-X-X-(\\d{4})\\]\\s*Stmt\\.?\\s*Date:?\\s*(\\d{1,2})-([A-Za-z]{3})-(\\d{4})\\s*Stmt\\.?\\s*Bal:?\\s*(?:Rs\\.?|LKR)\\s*${N}`,
  'i',
);
// "Peoples Card: Re-payment Reminder [X-X-X-1913][Tot.Payable Rs.123,456.78] Min.Payment due …"
const PEOPLES_REMINDER_RE = new RegExp(
  `Re-?payment Reminder\\s*\\[X-X-X-(\\d{4})\\]\\s*\\[Tot\\.?\\s*Payable\\s*(?:Rs\\.?|LKR)\\s*${N}\\]`,
  'i',
);
// "Dear Card Holder, kind notification of the minimum payment Rs 1234.56 of your Peoples Credit Card due by …"
// "Dear Cardholder, Minimum of Rs 1234.56 of your Peoples Card is due by …"
const PEOPLES_MIN_DUE_RE = new RegExp(
  `(?:minimum payment|Minimum of)\\s+(?:Rs\\.?|LKR)\\s*${N}\\s+of your Peoples (?:Credit )?Card`,
  'i',
);

const peoples: Parser = (body) => {
  let m = PEOPLES_INSTALMENT_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.instalment', kind: 'info', last_digits: null, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: clean(m[3]), balance_after: null, bank_txn_id: null,
    };
  }
  m = PEOPLES_STATEMENT_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.statement', kind: 'info', last_digits: m[1]!, currency: 'LKR', amount: parseMoney(m[5]),
      merchant_text: 'Statement', balance_after: null, bank_txn_id: null, occurred_on: dayMonth(m[2]!, m[3]!, '', m[4]),
    };
  }
  m = PEOPLES_REMINDER_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.reminder', kind: 'info', last_digits: m[1]!, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: 'Payment reminder', balance_after: null, bank_txn_id: null,
    };
  }
  m = PEOPLES_MIN_DUE_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.min_due', kind: 'info', last_digits: null, currency: 'LKR', amount: parseMoney(m[1]),
      merchant_text: 'Minimum payment due', balance_after: null, bank_txn_id: null,
    };
  }
  m = PEOPLES_CHARGE_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.charge', kind: 'card_charge', last_digits: m[1]!, currency: m[2]!.toUpperCase(),
      amount: parseMoney(m[3]), merchant_text: clean(m[4]), balance_after: parseMoney(m[5]), bank_txn_id: null,
    };
  }
  m = PEOPLES_PAYMENT_RE.exec(body);
  if (m) {
    return {
      parser: 'peoples.payment', kind: 'card_payment', last_digits: m[1]!, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: 'Payment received', balance_after: null, bank_txn_id: null,
      occurred_on: dayMonth(m[3]!, m[4]!, '', m[5]),
    };
  }
  return null;
};

// ── Seylan ───────────────────────────────────────────────────────────────────
// "Seylan Card ...6029 debit Txn 10357428172 of LKR 550.00 done on 12/09/2026 01:09:29 PM at Google One
//  650-2530000 US. Avl bal 14,722.11"
// "Seylan Credit Card Services - Thank you for your payment of LKR 25,000.00 made to Card # ...6029 on
//  25/08/2026 06:30:18 PM. Avl bal 36,644.16"
const SEYLAN_TXN_RE = new RegExp(
  `Seylan Card\\s*\\.*(\\d{4})\\s+(debit|credit)\\s+Txn\\s+(\\d+)\\s+of\\s+([A-Z]{3})\\s*${N}\\s+done on\\s+${DMY}\\s+${T12}\\s+at\\s+(.+?)\\.?\\s+Avl bal\\s*(?:LKR|Rs\\.?)?\\s*${N}`,
  'i',
);
const SEYLAN_PAYMENT_RE = new RegExp(
  `Thank you for your payment of\\s+([A-Z]{3})\\s*${N}\\s+made to Card\\s*#?\\s*\\.*(\\d{4})\\s+on\\s+${DMY}\\s+${T12}\\.?\\s*Avl bal\\s*(?:LKR|Rs\\.?)?\\s*${N}`,
  'i',
);
// "Transaction Reversal (10063001165): Seylan Card ...6029 was credited USD 6.15 on 09/06/2026 08:10:00 AM
//  at TEMU.COM +442033454976IE. Avl bal 12,345.67" — the id in brackets is the ORIGINAL charge's Txn id,
// so it is stored as "R<id>" (the inbox keeps bank ids unique) and the matcher finds the charge by it.
const SEYLAN_REVERSAL_RE = new RegExp(
  `Transaction Reversal\\s*\\((\\d+)\\):?\\s*Seylan Card\\s*\\.*(\\d{4})\\s+was credited\\s+([A-Z]{3})\\s*${N}\\s+on\\s+${DMY}\\s+${T12}\\s+at\\s+(.+?)\\.?\\s+Avl bal\\s*(?:LKR|Rs\\.?)?\\s*${N}`,
  'i',
);

/** "R10063001165" (a Seylan reversal) → the original charge's bank txn id. */
export function reversedTxnId(bankTxnId: string | null): string | null {
  return bankTxnId && /^R\d+$/.test(bankTxnId) ? bankTxnId.slice(1) : null;
}

const seylan: Parser = (body) => {
  let m = SEYLAN_REVERSAL_RE.exec(body);
  if (m) {
    return {
      parser: 'seylan.reversal', kind: 'refund', bank_txn_id: `R${m[1]!}`, last_digits: m[2]!,
      currency: m[3]!.toUpperCase(), amount: parseMoney(m[4]), occurred_on: dmy(m[5]!), occurred_at: time12(m[6]!),
      merchant_text: clean(m[7]), balance_after: parseMoney(m[8]),
    };
  }
  m = SEYLAN_TXN_RE.exec(body);
  if (m) {
    const debit = m[2]!.toLowerCase() === 'debit';
    return {
      parser: debit ? 'seylan.charge' : 'seylan.credit', kind: debit ? 'card_charge' : 'unknown',
      last_digits: m[1]!, bank_txn_id: m[3]!, currency: m[4]!.toUpperCase(), amount: parseMoney(m[5]),
      occurred_on: dmy(m[6]!), occurred_at: time12(m[7]!), merchant_text: clean(m[8]), balance_after: parseMoney(m[9]),
    };
  }
  m = SEYLAN_PAYMENT_RE.exec(body);
  if (m) {
    return {
      parser: 'seylan.payment', kind: 'card_payment', currency: m[1]!.toUpperCase(), amount: parseMoney(m[2]),
      last_digits: m[3]!, occurred_on: dmy(m[4]!), occurred_at: time12(m[5]!), merchant_text: 'Payment received',
      balance_after: parseMoney(m[6]), bank_txn_id: null,
    };
  }
  return null;
};

// ── Sampath bank account + fixed deposit (SAMPATHTXN, Phase 9b.1) ───────────
// "LKR 50.00 debited from AC **1110 for DORMANT_CHG_052026 04/05/2026 06:36:44 To Inq Call 0112303050 Get
//  protected -Do not Share OTP"
// "LKR 2,104.04 credited to AC **2229 for FD Interest X2229:Int.Pd:21-11-2025 to 20-05-2026 20/05/2026 23:04:21 …"
// "FD **2229 renewed LKR 61,033.85 for 6 Month(s) 20/05/2026 23:25:20 …"
const SAMPATH_AC_RE = new RegExp(
  `^(?:LKR|Rs\\.?)\\s*${N}\\s+(debited from|credited to)\\s+AC\\s*\\**\\s*(\\d{3,4})\\s+for\\s+(.+?)\\s+${DMY}\\s+(\\d{1,2}:\\d{2}:\\d{2})`,
  'i',
);
const SAMPATH_FD_RENEW_RE = new RegExp(`^FD\\s*\\**\\s*(\\d{3,4})\\s+renewed\\s+(?:LKR|Rs\\.?)\\s*${N}`, 'i');

const sampathAccount: Parser = (body) => {
  let m = SAMPATH_AC_RE.exec(body);
  if (m) {
    const debit = m[2]!.toLowerCase().startsWith('debited');
    // "FD Interest X2229:Int.Pd:…" → "FD Interest"; "DORMANT_CHG_052026" → "DORMANT CHG"
    const desc = m[4]!.split(/\s+X?\d|:/)[0]!.replace(/_\d+$/, '').replace(/_/g, ' ');
    return {
      parser: debit ? 'sampath.account_debit' : 'sampath.account_credit', kind: debit ? 'bank_debit' : 'bank_credit',
      last_digits: m[3]!, currency: 'LKR', amount: parseMoney(m[1]), merchant_text: clean(desc), balance_after: null,
      bank_txn_id: null, occurred_on: dmy(m[5]!), occurred_at: time24(m[6]!),
    };
  }
  m = SAMPATH_FD_RENEW_RE.exec(body);
  if (m) {
    return {
      parser: 'sampath.fd_renewed', kind: 'info', last_digits: m[1]!, currency: 'LKR', amount: parseMoney(m[2]),
      merchant_text: 'FD renewed', balance_after: null, bank_txn_id: null,
    };
  }
  return null;
};

// ── Payees' confirmations (kind `receipt`, Phase 9b.1) ───────────────────────
// SLTBILL  "Your bill payment Rs.3400.00 has been received to account number 0034847977 (94113602084) on
//           2026/09/22:02:34:51 AM. Thank you."
// LECO     "A payment of Rs. 19,700.00 on A/C: 0103482401 is received by 06-MAY-26 14:40:00"
// Mobitel  "You have recharged Rs. 50.00 Your account balance is Rs. 50.55 ,expires on 13/11/2026 …"
// Dialog   "You have successfully activated the Rs.198 Any Network Voice plan …"
// Star Points "… for the Dialog Mobile reload of Rs. 198.00/- made on 20/10/2026 18:20:50 …"
//             "… for your transaction at Cargills Rewards on 2026/10/20 21:10:25 …" (a note: no amount)
const SLT_BILL_RE = new RegExp(
  `bill payment\\s+Rs\\.?\\s*${N}\\s+has been received.*?\\bon\\s+(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})[:\\s]+(\\d{1,2}:\\d{2}(?::\\d{2})?\\s*[AP]M)`,
  'i',
);
const LECO_RE = new RegExp(
  `payment of\\s+Rs\\.?\\s*${N}\\s+on\\s+A\\/C:?\\s*\\d+\\s+is received by\\s+(\\d{1,2})-([A-Za-z]{3})-(\\d{2,4})\\s+(\\d{1,2}:\\d{2}:\\d{2})`,
  'i',
);
const MOBITEL_RECHARGE_RE = new RegExp(`You have recharged\\s+Rs\\.?\\s*${N}`, 'i');
const DIALOG_PLAN_RE = new RegExp(`successfully activated the\\s+Rs\\.?\\s*${N}\\b`, 'i');
// "Work & Learn quota of Rs.672 Work & Learn Plan activated on 27/09/2026 is over." — names the purchase
// and its day (the plan's own activation message may be missing)
const DIALOG_QUOTA_RE = new RegExp(`quota of\\s+Rs\\.?\\s*${N}\\b.*?\\bactivated on\\s+${DMY}`, 'i');
const STAR_RELOAD_RE = new RegExp(
  `(Dialog|Mobitel|Airtel|Hutch)[\\w ]*?reload of\\s+Rs\\.?\\s*${N}\\s*(?:\\/-)?\\s*made on\\s+${DMY}\\s+(\\d{1,2}:\\d{2}:\\d{2})`,
  'i',
);
const STAR_SHOP_RE = /transaction at\s+(.+?)\s+on\s+(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})/i;

const yearFirst = (y: string, m: string, d: string) => `${y}-${pad(Number(m))}-${pad(Number(d))}`;
const receipt = (parser: string, payee: string, amount: string | undefined, on?: string | null, at?: string | null): Fields => ({
  parser, kind: 'receipt', last_digits: null, currency: 'LKR', amount: parseMoney(amount), merchant_text: payee,
  balance_after: null, bank_txn_id: null, occurred_on: on ?? null, occurred_at: at ?? null,
});

const sltBill: Parser = (body) => {
  const m = SLT_BILL_RE.exec(body);
  return m ? receipt('slt.bill', 'SLT bill', m[1], yearFirst(m[2]!, m[3]!, m[4]!), time12(m[5]!)) : null;
};
const leco: Parser = (body) => {
  const m = LECO_RE.exec(body);
  return m ? receipt('leco.bill', 'LECO electricity', m[1], dayMonth(m[2]!, m[3]!, '', m[4]!.length === 2 ? `20${m[4]}` : m[4]), time24(m[5]!)) : null;
};
const mobitel: Parser = (body) => {
  const m = MOBITEL_RECHARGE_RE.exec(body);
  return m ? receipt('mobitel.recharge', 'Mobitel recharge', m[1]) : null;
};
const dialog: Parser = (body) => {
  let m = DIALOG_PLAN_RE.exec(body);
  if (m) return receipt('dialog.plan', 'Dialog plan', m[1]);
  m = DIALOG_QUOTA_RE.exec(body);
  return m ? receipt('dialog.plan_used', 'Dialog plan', m[1], dmy(m[2]!)) : null;
};
const starPoints: Parser = (body) => {
  let m = STAR_RELOAD_RE.exec(body);
  if (m) return receipt('starpoints.reload', `${m[1]} reload`, m[2], dmy(m[3]!), time24(m[4]!));
  m = STAR_SHOP_RE.exec(body);
  if (m) {
    return {
      parser: 'starpoints.shop', kind: 'info', last_digits: null, currency: 'LKR', amount: null,
      merchant_text: clean(m[1]!.replace(/\s+Rewards$/i, '')), balance_after: null, bank_txn_id: null,
      occurred_on: yearFirst(m[2]!, m[3]!, m[4]!), occurred_at: time24(m[5]!),
    };
  }
  return null;
};

const PARSERS: Record<string, Parser> = { BOC: boc, Sampath: sampath, "People's": peoples, Seylan: seylan };
/** Senders whose alerts need their own parser (same institution, other formats). */
// ── BOC Flex (BOCONLINE, Phase 9b.2) ─────────────────────────────────────────
// "Your Tap & Pay transaction of LKR 2252.00 from XXXX3399 at GUNASEKARA & COMPANY was successful. Ref: VC_7760QQS8"
// The wallet (··3399) is topped up in the BOC Flex app; that top-up sends no SMS (see the balance gaps).
const BOC_TAP_PAY_RE = new RegExp(
  `^Your Tap\\s*&\\s*Pay transaction of\\s+(LKR|Rs\\.?|USD)\\s*${N}\\s+from\\s+[X*x]+(\\d{4})\\s+at\\s+(.+?)\\s+was successful\\.?\\s*(?:Ref\\s*:?\\s*(VC_[A-Z0-9]+))?`,
  'i',
);

// "Hey there, You have received LKR 5,000.00. from DR (MRS) …" — money into the wallet (no card digits)
const BOC_FLEX_RECEIVED_RE = new RegExp(`^Hey there,?\\s*You have received\\s+(LKR|Rs\\.?)\\s*${N}\\.?\\s+from\\s+(.+?)\\.?\\s*$`, 'i');

const bocOnline: Parser = (body) => {
  const r = BOC_FLEX_RECEIVED_RE.exec(body);
  if (r) {
    return {
      parser: 'boconline.received', kind: 'bank_credit', last_digits: null, currency: 'LKR', amount: parseMoney(r[2]),
      merchant_text: clean(r[3]), balance_after: null, bank_txn_id: null,
    };
  }
  const m = BOC_TAP_PAY_RE.exec(body);
  if (!m) return null;
  const currency = /^rs/i.test(m[1]!) ? 'LKR' : m[1]!.toUpperCase();
  return {
    parser: 'boconline.tap_pay', kind: 'bank_debit', last_digits: m[3]!, currency, amount: parseMoney(m[2]),
    merchant_text: clean(m[4]), balance_after: null, bank_txn_id: m[5] ? m[5].toUpperCase() : null,
  };
};

const SENDER_PARSERS: Record<string, Parser> = {
  BOCONLINE: bocOnline,
  SAMPATHTXN: sampathAccount, SLTBILL: sltBill, LECOBILL: leco, SLTMOBITEL: mobitel, '5555': dialog, STARPOINTS: starPoints,
};

// ── Entry point ──────────────────────────────────────────────────────────────
/** Filter + parse one SMS. Dropped texts come back with a reason only (never their content). */
export function parseSms(raw: RawSms): SmsVerdict {
  const sender = String(raw.sender ?? '').replace(/\s+/g, ' ').trim();
  const body = String(raw.body ?? '').replace(/\r\n?/g, '\n').trim();
  const receivedAt = toIso(raw.receivedAt);
  if (!sender || !body || body.length > 1000 || !receivedAt) return { keep: false, reason: 'invalid' };

  const institution = institutionFor(sender);
  if (!institution) return { keep: false, reason: 'sender' };
  if (isSecret(body, sender)) return { keep: false, reason: 'otp' };
  if (isPromo(body)) return { keep: false, reason: 'promo' };
  const receiptSender = isReceiptSender(sender);
  if (!receiptSender && !AMOUNT_RE.test(body)) return { keep: false, reason: 'no_amount' };

  const received = colomboParts(receivedAt);
  const flat = body.replace(/\s+/g, ' ');
  const f = (SENDER_PARSERS[senderKey(sender)] ?? PARSERS[institution])?.(flat, received.date) ?? null;
  // A payee's message is kept only when it confirms a payment (or names a shop at a time).
  if (receiptSender && (!f || (f.amount === null && f.kind !== 'info'))) return { keep: false, reason: 'notice' };

  const base = {
    sender, body, received_at: receivedAt, fingerprint: smsFingerprint(sender, body, receivedAt),
    parser_version: PARSER_VERSION, institution,
  };

  if (!f || (f.amount === null && f.kind !== 'info')) {
    // Allow-listed, has an amount, but a format we haven't seen: keep it so a new format shows up.
    const am = AMOUNT_RE.exec(flat);
    const cur = am?.[1]?.toUpperCase().startsWith('RS') ? 'LKR' : (am?.[1]?.toUpperCase() ?? 'LKR');
    return {
      keep: true,
      sms: {
        ...base, parser: null, kind: 'unknown', last_digits: /[X*.]+\s?(\d{3,4})\b/.exec(flat)?.[1] ?? null,
        amount: parseMoney(am?.[0]?.replace(/^[A-Za-z.]+\s?/, '')), currency: cur, balance_after: null,
        merchant_text: null, bank_txn_id: null, occurred_on: received.date, occurred_at: received.time,
      },
    };
  }

  const occurredOn = f.occurred_on ?? received.date;
  // An alert without its own time (BOC, Sampath) happened when it arrived — if it's the same day.
  const occurredAt = f.occurred_at ?? (occurredOn === received.date ? received.time : null);
  return {
    keep: true,
    sms: {
      ...base, parser: f.parser, kind: f.kind, last_digits: f.last_digits, amount: f.amount, currency: f.currency,
      balance_after: f.balance_after, merchant_text: f.merchant_text, bank_txn_id: f.bank_txn_id,
      occurred_on: occurredOn, occurred_at: occurredAt,
    },
  };
}
