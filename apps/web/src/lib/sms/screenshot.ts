// Bank alerts from a screenshot (Phase 7c): the Bill Scanner copies each SMS of a bank's thread
// (doc_type 'bank_sms'); here each one gets its day and time, is parsed by the same bank parsers as
// the phone's forwarder, and is checked against the inbox so an alert that did arrive isn't added
// twice. Pure: unit-tested without Supabase.
import { parseSms, type ParsedSms } from '@sms/parse';
import type { BankSmsDoc } from '@scan/schema.ts';
import type { BackupSms } from './backupXml';

export interface ShotRow {
  key: string;
  sender: string;
  body: string;
  /** YYYY-MM-DD in Colombo, or null when it couldn't be worked out. */
  date: string | null;
  time: string | null;
  /** The day is an estimate (no date in the screenshot and no capture date): the person checks it. */
  guessed: boolean;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A moment → its calendar day in Asia/Colombo. */
export function colomboDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A day as a messaging app shows it, seen on `base` (the day the screenshot was taken):
 * "Today", "Yesterday", a weekday (the last one before yesterday), or "12 Sep" / "Sep 12"
 * (this year, or last year if that would be after `base`).
 */
export function resolveDayLabel(label: string, base: string): string | null {
  const l = label.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  if (!l) return null;
  if (l === 'today') return base;
  if (l === 'yesterday') return addDays(base, -1);
  const wd = WEEKDAYS.findIndex((w) => l === w || l === w.slice(0, 3));
  if (wd >= 0) {
    for (let back = 1; back <= 7; back++) {
      const d = addDays(base, -back);
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === wd) return d;
    }
  }
  const m = /^(?:\w+ )?(\d{1,2}) ([a-z]{3})[a-z]*(?: (\d{4}))?$/.exec(l) ?? /^(?:\w+ )?([a-z]{3})[a-z]* (\d{1,2})(?: (\d{4}))?$/.exec(l);
  if (m) {
    const [dayStr, monStr] = /^\d/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    const month = MONTHS.indexOf(monStr.slice(0, 3));
    if (month < 0) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    let year = m[3] ? Number(m[3]) : Number(base.slice(0, 4));
    let d = `${year}-${pad(month + 1)}-${pad(Number(dayStr))}`;
    if (!m[3] && d > base) {
      year -= 1;
      d = `${year}-${pad(month + 1)}-${pad(Number(dayStr))}`;
    }
    return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? null : d;
  }
  return null;
}

/**
 * The file's alerts with their days. The base day is the capture date the scanner saw, else the day
 * the file reached Drive (then every day is marked as a guess). A message without a day label
 * belongs to the group above it, as in the messaging app.
 */
export function screenshotRows(docs: BankSmsDoc[], fileTime: Date): ShotRow[] {
  const rows: ShotRow[] = [];
  docs.forEach((doc, di) => {
    const base = doc.captured_on ?? colomboDay(fileTime);
    const baseKnown = Boolean(doc.captured_on);
    let prev: { date: string | null; guessed: boolean } | null = null;
    doc.messages.forEach((m, mi) => {
      let date: string | null;
      let guessed = false;
      if (m.date) {
        date = m.date;
      } else if (m.day_label) {
        date = resolveDayLabel(m.day_label, base);
        guessed = !baseKnown || date === null;
      } else if (prev) {
        ({ date, guessed } = prev);
      } else {
        date = base;
        guessed = true;
      }
      prev = { date, guessed };
      rows.push({
        key: `${di}-${mi}`,
        sender: (m.sender ?? doc.sender ?? '').trim(),
        body: m.body,
        date,
        time: m.time ? m.time.padStart(5, '0') : null,
        guessed,
      });
    });
  });
  return rows;
}

/** The moment an alert arrived (Colombo time; noon when the screenshot shows no time). */
export function receivedAt(date: string, time: string | null): number {
  return Date.parse(`${date}T${time ?? '12:00'}:00+05:30`);
}

/** Parsed like a forwarded alert, or why it's left out (OTP, not a bank, no amount …). */
export function parseRow(row: ShotRow): { sms: ParsedSms } | { reason: string } {
  if (!row.date || !row.sender) return { reason: 'noDate' };
  const v = parseSms({ sender: row.sender, body: row.body, receivedAt: receivedAt(row.date, row.time) });
  return v.keep ? { sms: v.sms } : { reason: v.reason };
}

export function toBackup(row: ShotRow): BackupSms | null {
  if (!row.date || !row.sender) return null;
  return { sender: row.sender, body: row.body, receivedAt: receivedAt(row.date, row.time) };
}

export interface InboxFacts {
  institution: string | null;
  amount: number | null;
  balance_after: number | null;
  last_digits: string | null;
  received_at: string;
}

/**
 * Did this alert reach Gedara already (e.g. the forwarder did send it)? Same bank and amount, and
 * the same balance after it within ±36 h (the balance is different after every transaction); an
 * alert without a balance needs the same account within ±10 minutes. Text isn't compared: a
 * transcription can differ from the real SMS by a space.
 */
export function alreadyIn(sms: ParsedSms, inbox: InboxFacts[]): boolean {
  const at = Date.parse(sms.received_at);
  return inbox.some((r) => {
    if (r.institution !== sms.institution || r.amount === null || sms.amount === null) return false;
    if (Math.abs(Number(r.amount) - sms.amount) > 0.001) return false;
    const gap = Math.abs(Date.parse(r.received_at) - at);
    if (r.balance_after !== null && sms.balance_after !== null) {
      return Math.abs(Number(r.balance_after) - sms.balance_after) < 0.001 && gap <= 36 * 3600_000;
    }
    return r.last_digits === sms.last_digits && gap <= 10 * 60_000;
  });
}
