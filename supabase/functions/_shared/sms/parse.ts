// Bank / card SMS alerts → parsed rows for the review inbox (Phase 2b).
// Shared by the sms-ingest Edge Function (Deno) and the web app (SMS-backup preview, via the `@sms`
// alias), so it must stay plain TypeScript with NO imports. Formats are Didula's real alerts
// (docs/sms-forwarder-setup.md lists them). Bump PARSER_VERSION when a parser's output changes.
//
// Safety: only allow-listed senders are parsed; OTP / PIN / promo texts are dropped before parsing
// and are never stored (the database drops OTP-looking text again).

export const PARSER_VERSION = 1;

export type SmsKind = 'card_charge' | 'card_payment' | 'bank_debit' | 'bank_credit' | 'atm' | 'unknown';

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

export type DropReason = 'sender' | 'otp' | 'promo' | 'no_amount' | 'invalid';

export type SmsVerdict = { keep: true; sms: ParsedSms } | { keep: false; reason: DropReason };

// ── Senders ──────────────────────────────────────────────────────────────────
// Sender id (letters and digits only, upper case) → institution as written on `account.institution`.
const SENDERS: Record<string, string> = {
  BOC: 'BOC',
  SAMPCCTXN: 'Sampath',
  PEOPLESCARD: "People's",
  SEYLANBANK: 'Seylan',
  SEYLAN: 'Seylan',
};

/** The sender ids the phone should forward (for the forwarder's sender regex). */
export const FORWARD_SENDERS = ['BOC', 'SAMPCCTXN', 'PeoplesCard', 'Seylan Bank'] as const;

export function senderKey(sender: string): string {
  return sender.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Institution for an allow-listed sender, else null. */
export function institutionFor(sender: string): string | null {
  return SENDERS[senderKey(sender)] ?? null;
}

// ── Filters ──────────────────────────────────────────────────────────────────
const SECRET_RE =
  /\b(otp|one[ -]?time|pass ?code|password|verification code|security code|pin|do not share|never share)\b|\bcode (is|:)\s*\d{4,8}\b/i;
const PROMO_RE = /NOPROM|STOP ?SMS|unsubscribe|\b\d{1,2}% ?(off|discount|cash ?back|savings?)\b|\benjoy\b.*\d{1,2}%/i;
const AMOUNT_RE = /\b(LKR|Rs\.?|USD|EUR|GBP|SGD|AUD|INR)\s?\d[\d,]*(\.\d{1,2})?/i;

export function isSecret(body: string): boolean {
  return SECRET_RE.test(body);
}

export function isPromo(body: string): boolean {
  return PROMO_RE.test(body);
}

/** For the forwarder app's "text filter": forward only texts that are NOT secret-looking. */
export const FORWARD_TEXT_REGEX =
  '(?is)^(?!.*\\b(otp|one[ -]?time|pass ?code|password|verification code|security code|pin|do not share|never share)\\b).*$';

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
  const cleaned = text.replace(/[,\s]/g, '').replace(/^(rs\.?|lkr)/i, '').replace(/\.$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
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

const N = '([\\d,]+(?:\\.\\d{1,2})?)'; // an amount

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

const boc: Parser = (body) => {
  let m = BOC_CARD_RE.exec(body);
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

const peoples: Parser = (body) => {
  let m = PEOPLES_CHARGE_RE.exec(body);
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
  `Seylan Card\\s*\\.*(\\d{4})\\s+(debit|credit)\\s+Txn\\s+(\\d+)\\s+of\\s+([A-Z]{3})\\s*${N}\\s+done on\\s+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?\\s*[AP]M)\\s+at\\s+(.+?)\\.?\\s+Avl bal\\s*(?:LKR|Rs\\.?)?\\s*${N}`,
  'i',
);
const SEYLAN_PAYMENT_RE = new RegExp(
  `Thank you for your payment of\\s+([A-Z]{3})\\s*${N}\\s+made to Card\\s*#?\\s*\\.*(\\d{4})\\s+on\\s+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?\\s*[AP]M)\\.?\\s*Avl bal\\s*(?:LKR|Rs\\.?)?\\s*${N}`,
  'i',
);

const seylan: Parser = (body) => {
  let m = SEYLAN_TXN_RE.exec(body);
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

const PARSERS: Record<string, Parser> = { BOC: boc, Sampath: sampath, "People's": peoples, Seylan: seylan };

// ── Entry point ──────────────────────────────────────────────────────────────
/** Filter + parse one SMS. Dropped texts come back with a reason only (never their content). */
export function parseSms(raw: RawSms): SmsVerdict {
  const sender = String(raw.sender ?? '').replace(/\s+/g, ' ').trim();
  const body = String(raw.body ?? '').replace(/\r\n?/g, '\n').trim();
  const receivedAt = toIso(raw.receivedAt);
  if (!sender || !body || body.length > 1000 || !receivedAt) return { keep: false, reason: 'invalid' };

  const institution = institutionFor(sender);
  if (!institution) return { keep: false, reason: 'sender' };
  if (isSecret(body)) return { keep: false, reason: 'otp' };
  if (isPromo(body)) return { keep: false, reason: 'promo' };
  if (!AMOUNT_RE.test(body)) return { keep: false, reason: 'no_amount' };

  const received = colomboParts(receivedAt);
  const flat = body.replace(/\s+/g, ' ');
  const f = PARSERS[institution]?.(flat, received.date) ?? null;

  const base = {
    sender, body, received_at: receivedAt, fingerprint: smsFingerprint(sender, body, receivedAt),
    parser_version: PARSER_VERSION, institution,
  };

  if (!f || f.amount === null) {
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
