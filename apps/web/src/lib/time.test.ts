import { describe, expect, it } from 'vitest';
import { addMonths, dayPart, firstName, formatDay, hourIn, initials, longDate, monthRange, timeNowIn, todayIn } from './time';

describe('time helpers', () => {
  // 2026-09-23 13:10 UTC = 18:40 in Colombo (UTC+5:30)
  const now = new Date('2026-09-23T13:10:00Z');

  it('reads the hour in the household timezone', () => {
    expect(hourIn('Asia/Colombo', now)).toBe(18);
    expect(hourIn('UTC', now)).toBe(13);
  });

  it('maps hours to greetings', () => {
    expect(dayPart(6)).toBe('morning');
    expect(dayPart(12)).toBe('afternoon');
    expect(dayPart(18)).toBe('evening');
    expect(dayPart(2)).toBe('evening');
  });

  it('formats the long date in Colombo', () => {
    expect(longDate('Asia/Colombo', 'en-LK', new Date('2026-09-23T20:00:00Z'))).toContain('24');
    // Day/month order depends on the ICU build; check the parts.
    const d = longDate('Asia/Colombo', 'en-LK', now);
    for (const part of ['Wednesday', '23', 'September']) expect(d).toContain(part);
  });

  it('derives first names and initials', () => {
    expect(firstName('Didula Ayeshmantha', 'x@y.z')).toBe('Didula');
    expect(firstName(null, 'sandeepani@gmail.com')).toBe('Sandeepani');
    expect(initials('Didula Ayeshmantha', 'x@y.z')).toBe('DA');
    expect(initials(null, 'ab@c.d')).toBe('AB');
  });

  it('knows today and the time in Colombo, across UTC midnight', () => {
    const late = new Date('2026-09-23T19:45:00Z'); // 01:15 on the 24th in Colombo
    expect(todayIn('Asia/Colombo', late)).toBe('2026-09-24');
    expect(timeNowIn('Asia/Colombo', late)).toBe('01:15');
  });

  it('does month arithmetic on YYYY-MM', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-10-01' });
    expect(formatDay('2026-09-24', 'en-LK', '2026')).toContain('24');
  });
});
