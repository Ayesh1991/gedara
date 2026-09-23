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
