// Ask Gedara, part 2: what may leave Gedara for an AI (Phase 10). Only three things ever do: the fixed
// instructions, today's date and the person's own question. The question is checked first:
//   * OTP / password / PIN wording (English, Sinhala, Tamil — the shared SMS detector)  → refused;
//   * a card or account number (9+ digits, also with spaces or dashes)                   → refused;
//   * a 4–8-digit number that isn't a year, money, a quantity or a card's last digits     → refused (could be a code);
//   * an e-mail address                                                                   → masked;
// numbers people really ask with stay: "Rs 50,000", "5000 rupees", "2 kg", "2026", "last 30 days", "··6029".
// assertAskUser() is the last gate before fetch: the user message must be exactly { today, question }
// with a question that passes the same check. Plain TypeScript; imports only the shared detector.
import { secretReason } from '../sms/secret.ts';

export const MAX_QUESTION = 300;

export type QuestionProblem = 'empty' | 'too_long' | 'otp' | 'card' | 'code';
export type QuestionCheck = { ok: true; text: string } | { ok: false; reason: QuestionProblem };

const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u200B-\u200F\u2060\uFEFF]/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// a long digit run, possibly broken by spaces or dashes ("4111 1111 1111 1111", "0112-300-604")
const LONG_RUN = /\p{Nd}(?:[\s-]?\p{Nd}){8,}/u;
const DATES = /(?<!\p{Nd})(?:\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}|\p{Nd}{1,2}[/.]\p{Nd}{1,2}[/.]\p{Nd}{2,4})(?!\p{Nd})/gu;
// a number: grouped / decimal ("50,000", "12.5"), or short groups typed apart ("482-913", "4 8 2 9 1 3")
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)+|\p{Nd}{1,3}(?:[ -]\p{Nd}{1,3})+(?!\p{Nd})|\p{Nd}+/gu;
const MONEY_BEFORE = /(?:rs\.?|lkr|රු\.?|රුපියල්|ரூ\.?)\s*$/iu;
// "over 5000", "spent 25000", "a bill of 12000": comparison and money words right before the number
const WORD_BEFORE = /(?:^|[^\p{L}])(?:over|above|under|below|than|about|around|exceeding|exceeds?|spent|spend|spending|cost|costs|paid|pay|of|top|last)\s*$/iu;
// "card 6029", "ending 319", "··708": the last digits of a card or account (3–4 digits only)
const LAST_DIGITS_BEFORE = /(?:card|ending(?: in)?|a\/c|account|acc|··|\.\.|x{2,}|\*{2,})\s*$/iu;
const AFTER_OK =
  /^\s*(?:rupees?|රු|රුපියල්|ரூபாய்|\/-|g|gm|gms|kg|mg|ml|l|ltr|km|m|kwh|units?|days?|weeks?|months?|years?|ට|කට|වඩා|දින|සති|මාස|අවුරුදු)(?![\p{L}])/iu;

/** The question as it may be sent, or why it can't be. */
export function questionCheck(input: unknown): QuestionCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const text = input.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_QUESTION) return { ok: false, reason: 'too_long' };
  if (secretReason(text) === 'keyword') return { ok: false, reason: 'otp' };
  const masked = text.replace(EMAIL, '[email]');
  // calendar dates (2026-06-01, 1/6/2026) are not codes; checked with them set aside
  const scan = masked.replace(DATES, ' D ');
  if (LONG_RUN.test(scan)) return { ok: false, reason: 'card' };

  // A number of 4+ digits must be a year, money, a quantity or a card's last digits; anything else
  // could be a code (bank codes are 4–8 digits, in any digit script).
  for (const m of scan.matchAll(NUMBER)) {
    const token = m[0];
    const digits = token.replace(/[^\p{Nd}]/gu, '');
    if (digits.length < 4) continue;
    if (/[.,]/.test(token)) continue;
    if (digits.length >= 9) return { ok: false, reason: 'card' };
    const before = scan.slice(0, m.index);
    const after = scan.slice(m.index! + token.length);
    const grouped = /[ -]/.test(token);
    if (!grouped && digits.length === 4 && /^(?:19|20)\d\d$/.test(token)) continue;
    if (!grouped && digits.length === 4 && LAST_DIGITS_BEFORE.test(before)) continue;
    if (!grouped && (MONEY_BEFORE.test(before) || WORD_BEFORE.test(before) || AFTER_OK.test(after))) continue;
    return { ok: false, reason: 'code' };
  }
  return { ok: true, text: masked };
}

/** The user message sent to the model: today's date and the checked question, nothing else. */
export function buildUser(today: string, question: string): string {
  return JSON.stringify({ today, question });
}

export class UnsafeAsk extends Error {
  constructor(readonly reason: string) {
    super(`unsafe ask request: ${reason}`);
    this.name = 'UnsafeAsk';
  }
}

/** Last gate before fetch: exactly { today: YYYY-MM-DD, question: <passes questionCheck unchanged> }. */
export function assertAskUser(user: string): void {
  let v: unknown;
  try {
    v = JSON.parse(user);
  } catch {
    throw new UnsafeAsk('shape');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UnsafeAsk('shape');
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'question,today') throw new UnsafeAsk('shape');
  const { today, question } = v as { today: unknown; question: unknown };
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new UnsafeAsk('date');
  const check = questionCheck(question);
  if (!check.ok) throw new UnsafeAsk(check.reason);
  if (check.text !== question) throw new UnsafeAsk('unchecked');
}
