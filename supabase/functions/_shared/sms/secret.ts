// OTP / PIN / password detector (Phase 9 · hard rule: a bank one-time code must never be stored or
// reach an AI). ONE implementation, used by the SMS parser (phone backup import in the browser,
// sms-ingest) and by the AI gateway on every outgoing request; the database mirrors it in
// `private.sms_is_secret` (migration 77) — keep both in step and extend the shared corpus in
// apps/web/src/lib/sms/secret.test.ts + supabase/tests/database/sms_secret.test.sql together.
//
// Two independent checks, either one is enough to drop a text:
//   1. words: English, Sinhala and Tamil OTP / password / "don't share" wording, any position, also
//      glued to the code ("OTP482913");
//   2. fail closed: after every number a bank alert explains is blanked out (amounts, balances, dates,
//      times, masked accounts and cards, hotlines, bank reference ids), any 4–8-digit number left —
//      also written "4 8 2 9 1 3", "482-913" or in Sinhala / Tamil / full-width digits — is treated
//      as a code.
// Plain TypeScript with no imports (Deno + the web app's `@sms` alias).

export type SecretReason = 'keyword' | 'code';

// ── Normalising ──────────────────────────────────────────────────────────────
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/** Any Unicode decimal digit → its ASCII digit (Sinhala lith, Tamil, Devanagari, Arabic-Indic, …). */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x30 && cp <= 0x39) return ch;
    // Decimal digits come in runs of ten starting at zero: count how many digits precede this one.
    let k = 0;
    while (k < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp - k - 1))) k++;
    return String(k);
  });
}

/** Lower-case text with full-width forms folded (NFKC), invisible joiners removed, ASCII digits. */
export function normaliseForSecrets(text: string): string {
  return asciiDigits(String(text ?? '').normalize('NFKC').replace(ZERO_WIDTH, '')).toLowerCase();
}

// ── 1. Words ─────────────────────────────────────────────────────────────────
// English words must not sit inside a longer word ("spinach", "Auth Pmt"), but may touch digits.
const EN_WORDS = [
  'otp', 'otps', 'one ?-?time', 'pass ?-?code', 'pass ?-?word', 'passwd', 'm?-?pin', 't-?pin', 'e-?pin', 'pin ?no',
  'tac', 'cvv', 'cvc', 'verification', 'verify', 'security code', 'secret code', 'access code',
  'activation code', 'auth(?:entication|ori[sz]ation)? code', 'approval code', 'login code', 'sign[ -]?in code',
  'do ?not share', "don'?t share", 'never share', 'not to share', 'never disclose', 'do not disclose',
] as const;
const EN_RE = new RegExp(`(?<![a-z])(?:${EN_WORDS.join('|')})(?![a-z])`);
// "code 482913", "code: 4829", "code is 4829", "your code - 48 29".
const CODE_NEAR_RE = /(?<![a-z])codes?(?![a-z])(?:\s*(?:is|:|-|=|#))?\s*\d/;
const VALID_FOR_RE = /\b(?:valid|expires?|expiring)\s+(?:for|in|within)\s+\d+\s*(?:min|mins|minutes?|sec|secs|seconds?)\b/;

// Sinhala and Tamil words, matched as plain substrings (written without joiners — the text is too).
const SI_TA_WORDS = [
  // Sinhala: password, one-time, secret, code, verification, confirmation code, don't share, PIN number
  'මුරපද', 'මුර පද', 'එක් වරක්', 'එක්වරක්', 'එක් වරක', 'රහස්', 'රහස', 'කේත', 'සතයාපන', 'සත්යාපන',
  'තහවුරු කිරීමේ අංක', 'තහවුරු කිරීමේ කේත', 'බෙදා නොග', 'බෙදා නොදෙන්න', 'කිසිවෙකු සමඟ', 'කිසිවෙකුට', 'පින් අංක',
  // Tamil: password, one time, code, verification, secret, don't share
  'கடவுச்சொல்', 'கடவுச் சொல்', 'ஒருமுறை', 'ஒரு முறை', 'குறியீடு', 'சரிபார்ப்பு', 'இரகசிய', 'ரகசிய', 'பகிர வேண்டாம்', 'பகிர்ந்து கொள்ள வேண்டாம்',
].map((w) => w.normalize('NFKC').replace(ZERO_WIDTH, ''));

function hasSecretWords(norm: string): boolean {
  return EN_RE.test(norm) || CODE_NEAR_RE.test(norm) || VALID_FOR_RE.test(norm) || SI_TA_WORDS.some((w) => norm.includes(w));
}

// ── 2. Fail closed on an unexplained code-like number ────────────────────────
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const CUR = '(?:lkr|rs|usd|eur|gbp|sgd|aud|inr|aed|jpy|cny|රු|ரூ|₨)';
// Spans a real bank alert explains, blanked out (order matters: longest first).
const EXPLAINED: RegExp[] = [
  // amounts with a currency: "Rs. 1,000.00", "LKR .99", "USD 4.73", "Rs.999/="
  // (the currency word on its own: "offers. 482913" is not "Rs 482913" — Phase 9b.1)
  new RegExp(`(?<![a-z])${CUR}\\.?\\s*:?\\s*(?:\\d[\\d,]*(?:\\.\\d{1,2})?|\\.\\d{1,2})(?:\\s*/=)?`, 'g'),
  // money without a currency word: thousands commas or two decimals ("Avl bal 14,722.11")
  /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}(?!\d)/g,
  // dates: 12/09/2026, 12-09-26, 2026-09-12, 15-Sep-2026, 05-SEP, Sep 16, 2026, 26th June 2026
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // year first with slashes or dots: 2026/09/22 (SLTBILL "on 2026/09/22:02:34:51 AM"), 2026.09.22
  /\b\d{4}[/.]\d{1,2}[/.]\d{1,2}\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-]*${MON}(?:[\\s,-]*\\d{2,4})?\\b`, 'g'),
  new RegExp(`\\b${MON}\\s*\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{4}\\b`, 'g'),
  // times: 01:09:29 PM, 18:40
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  // masked accounts and cards: XXXXXXXXXX319, ..**6577, ...6029, X-X-X-1913, 5524 **** **** 8873
  /\d{4}(?:\s*[*x]{4}){2}\s*\d{4}/g,
  /(?:x-){2,}x?-?\d{2,4}/g,
  /[x*.#]{2,}\s?-?\d{2,4}\b/g,
  // a single X before the last digits (Sampath FD "X2229")
  /(?<![a-z\d])x\d{3,4}(?!\d)/g,
  // an unmasked account number named as such, longer than a usual code ("ETC A/C 1234567"); bank
  // reference ids only when longer than any code ("Txn 10357428172", "Transaction Reversal (10357428172)")
  /\b(?:a\/c|acc(?:ount)?|card)\.?\s*(?:no\.?|number|#)?\s*:?\s*\d{7,}/g,
  /\b(?:txn|trxn|ref(?:erence)?|reversal|receipt)\.?\s*(?:no\.?|number|#|id)?\s*[:(]?\s*\d{9,}/g,
  // short hotlines ("Hotline 1961"); phone numbers have 9+ digits, which are never taken for a code
  /\bhotline\s*:?\s*\d{3,5}(?!\d)/g,
];
// 4–8 digits in a row ("482913", even right next to another number), or 4–8 digits in small groups
// ("4 8 2 9 1 3", "482-913", "48.29.13"). Neither starts inside a longer number joined by a dash
// ("650-2530000" is a phone number in a merchant name, not "2530000").
const SOLID_CODE_RE = /(?<![\d-])\d{4,8}(?![\d-])/;
const GROUPED_CODE_RE = /(?<![\d.,])(?<!\d[ \-.])\d{1,3}(?:[ \-.]\d{1,3}){1,7}(?![ \-.]?\d)/g;

function hasUnexplainedCode(norm: string): boolean {
  let rest = norm;
  for (const re of EXPLAINED) rest = rest.replace(re, ' ');
  if (SOLID_CODE_RE.test(rest)) return true;
  for (const m of rest.matchAll(GROUPED_CODE_RE)) {
    const n = m[0].replace(/\D/g, '').length;
    if (n >= 4 && n <= 8) return true;
  }
  return false;
}

// ── Sender-specific allowances (Phase 9b.1) ─────────────────────────────────
// Sampath ends every account alert with a fixed safety line; only that exact line, only at the very
// end, is set aside — anything else in the text is checked as always (a real OTP that carries the same
// line still has its code and its wording before it).
const FOOTER = /\s*get protected\s*-\s*do not share otp\.?\s*$/;
// What a sender's alerts name that would otherwise look like a code: SAMPATHTXN writes the bank's own
// reference after "for" ("debited from AC **1110 for DORMANT_CHG_052026").
const SENDER_EXPLAINED: Record<string, RegExp[]> = {
  SAMPATHTXN: [/\bfor\s+[a-z]{2,}(?:_[a-z]{2,})+_\d{4,8}\b/g],
};
const senderKeyOf = (sender: string | null | undefined) => String(sender ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

// ── Entry points ─────────────────────────────────────────────────────────────
/**
 * Why a text looks like it carries a one-time code / password, or null when it doesn't. `sender` adds
 * only that sender's own allowance (SAMPATHTXN's references); without it the rules are the strictest.
 */
export function secretReason(text: string, sender?: string | null): SecretReason | null {
  const norm = normaliseForSecrets(text).replace(FOOTER, '');
  if (hasSecretWords(norm)) return 'keyword';
  let rest = norm;
  for (const re of SENDER_EXPLAINED[senderKeyOf(sender)] ?? []) rest = rest.replace(re, ' ');
  if (hasUnexplainedCode(rest)) return 'code';
  return null;
}

export function isSecret(text: string, sender?: string | null): boolean {
  return secretReason(text, sender) !== null;
}

/**
 * For the SMS-forwarder app's "text filter" (Java regex on the phone): forward only texts without
 * OTP wording — except Sampath's fixed closing line "Get protected -Do not Share OTP" at the very end
 * (tempered match: no wording may start anywhere before it). The phone can't run the number check —
 * sms-ingest and the database do.
 */
export const FORWARD_TEXT_REGEX =
  "(?isu)^(?:(?!(?:(?<![a-z])(?:otps?|one ?-?time|pass ?-?code|pass ?-?word|passwd|m?-?pin|t-?pin|e-?pin|tac|cvv|cvc|verification|verify|security code|secret code|access code|activation code|auth(?:entication|ori[sz]ation)? code|approval code|login code|do ?not share|don'?t share|never share|never disclose|do not disclose)(?![a-z])|(?<![a-z])codes?(?![a-z])(?:\\s*(?:is|:|-|=|#))?\\s*\\p{Nd}|මුරපද|මුර පද|එක් ?වරක|රහස|කේත|සත්\u200D?යාපන|බෙදා නොග|කිසිවෙකු|கடவுச் ?சொல்|ஒரு ?முறை|குறியீடு|சரிபார்ப்பு|ரகசிய|பகிர)).)*(?:get protected\\s*-\\s*do not share otp\\.?\\s*)?$";
