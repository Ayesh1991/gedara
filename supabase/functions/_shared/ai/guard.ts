// AI gateway, part 1: what may leave Gedara for an AI (Phase 9b · hard rule 1).
//
//   * An AI never sees an SMS body — only fields the parser took out of an alert that already passed
//     the OTP detector; those fields are checked again here with the full detector and every
//     4+-digit run in them is masked.
//   * Bill-scanner text (line and shop names) can't carry a bank code, but gets the same detector: OTP
//     wording or a code-like number makes the item stay with a person. Pack sizes ("1500 ML") and
//     model numbers glued to letters ("UA55AU7700") are allowed; 9+-digit numbers are masked.
//   * Nothing is identified by a real id or account number: products, categories, candidates and
//     accounts go out as short labels (P1, C3, T2, A1) and are mapped back afterwards.
//   * The last gate (assertSafeRequest) checks every text value of the finished request again; if
//     anything looks wrong the request is not sent at all.
// Plain TypeScript; imports only the shared detector.
import { secretReason } from '../sms/secret.ts';

export class UnsafePrompt extends Error {
  constructor(readonly reason: 'keyword' | 'code' | 'long_number' | 'date' | 'shape') {
    super(`unsafe prompt: ${reason}`);
    this.name = 'UnsafePrompt';
  }
}

const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
const CARD = /\d{4}(?:[\s-]*[*xX]{4}){2}[\s-]*\d{4}/g;
// "1500 ML", "2 x 500g", "55 inch": quantities are not codes
const UNITS = /\p{Nd}+(?:[.,]\p{Nd}+)?\s?(?:ml|l|ltr|lt|g|gm|gms|gr|kg|mg|pcs?|pack|pkt|cm|mm|m|w|v|mah|gb|tb|inch|in|x)(?!\p{L})/giu;
// digits glued to letters: model numbers ("au7700", "a4"), not codes on their own
const GLUED = /(?<=\p{L})\p{Nd}+|\p{Nd}+(?=\p{L})/gu;
// labels the caller makes (P12, C3, T2, A1) and calendar days
const LABEL = /^[A-Z]\d{1,4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function tidy(text: string | null | undefined, max: number): string {
  return String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** OTP wording, or a number that could be a code once quantities and model numbers are set aside. */
function unsafe(text: string): 'keyword' | 'code' | null {
  const why = secretReason(text);
  if (why !== 'code') return why;
  return secretReason(text.replace(UNITS, ' ').replace(GLUED, (m) => '#'.repeat(m.length)));
}

/** Text that came out of a bank alert (merchant, description): strictest rules. Throws when unsafe. */
export function smsText(text: string | null | undefined, max = 80): string {
  // the whole text, before shortening and masking: a code must stop the item, not be cut or hidden in it
  const why = secretReason(tidy(text, 2000));
  if (why) throw new UnsafePrompt(why);
  const t = tidy(text, max);
  return t.replace(CARD, '****').replace(/\p{Nd}{4,}/gu, (m) => '#'.repeat(m.length));
}

/** Text from a scanned bill or the household's own names. Throws when unsafe; masks 9+-digit numbers. */
export function billText(text: string | null | undefined, max = 100): string {
  const mask = (x: string) => x.replace(CARD, '****').replace(/\p{Nd}{9,}/gu, (m) => '#'.repeat(m.length));
  const why = unsafe(mask(tidy(text, 2000))); // the whole text, before shortening
  if (why) throw new UnsafePrompt(why);
  return mask(tidy(text, max));
}

/** A calendar day, and nothing else. */
export function day(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (!DAY.test(text)) throw new UnsafePrompt('date');
  return text;
}

/**
 * The last gate before fetch(): every text value in the request passes the detector again (labels and
 * days excepted), and no 9+-digit number appears anywhere (amounts never reach 9 digits).
 */
export function assertSafeRequest(serialised: string): void {
  if (/\d{9,}/.test(serialised)) throw new UnsafePrompt('long_number');
  let json: unknown;
  try {
    json = JSON.parse(serialised);
  } catch {
    throw new UnsafePrompt('shape');
  }
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') {
      if (key === 'day') {
        if (!DAY.test(v)) throw new UnsafePrompt('date');
        return;
      }
      if (LABEL.test(v)) return;
      const why = unsafe(tidy(v, 10_000));
      if (why) throw new UnsafePrompt(why);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(json, '');
}
