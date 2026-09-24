export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Hour of day (0–23) in the household's timezone. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now);
  return Number(h);
}

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

/** "Wednesday, 23 September" in the household's timezone. */
export function longDate(timeZone: string, locale = 'en-LK', now: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(now);
}

/** First name for greetings: display name's first word, else the email's local part. */
export function firstName(displayName: string | null | undefined, email: string): string {
  const fromName = displayName?.trim().split(/\s+/)[0];
  if (fromName) return fromName;
  const local = email.split('@')[0] ?? '';
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}

export function initials(displayName: string | null | undefined, email: string): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

// ── Calendar dates (money) ────────────────────────────────────────────────────
// Transactions store a plain date + local time of day. These helpers work on 'YYYY-MM-DD' strings
// and only use the timezone to decide what "today" is, so nothing shifts across midnight UTC.

/** Today's date 'YYYY-MM-DD' in the household's timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(now);
}

/** Current time 'HH:MM' (24 h) in the household's timezone. */
export function timeNowIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(now);
}

/** 'YYYY-MM' + n months → 'YYYY-MM'. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** First day of the month and first day of the next: the [start, end) range of 'YYYY-MM'. */
export function monthRange(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${addMonths(month, 1)}-01` };
}

const utcDate = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00Z`);

/** "Thu, 24 Sep" (adds the year when it isn't `currentYear`). */
export function formatDay(day: string, locale = 'en-LK', currentYear?: string): string {
  const withYear = currentYear !== undefined && day.slice(0, 4) !== currentYear;
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(utcDate(day));
}

/** "September 2026" / short: "Sep". */
export function formatMonth(month: string, locale = 'en-LK', short = false): string {
  return new Intl.DateTimeFormat(locale, short ? { month: 'short', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    utcDate(`${month}-01`),
  );
}
