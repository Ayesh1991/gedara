// Kitchen-scale numbers and wording (Phase 6b). Pure: no Supabase import, so tests can use it.
// Grams stay grams up to 1 kg, then kilograms; changes carry a real minus sign (−24 g).
import type { ReadingStatus } from '@scale/protocol';

const MINUS = '−';

/** 788 → "788 g", 812.4 → "812.4 g", 1250 → "1.25 kg". Never shows −0. */
export function formatGrams(g: number, locale = 'en-LK'): string {
  const abs = Math.abs(g);
  const sign = g < 0 && abs >= 0.05 ? MINUS : '';
  if (abs >= 1000) {
    const kg = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(abs / 1000);
    return `${sign}${kg} kg`;
  }
  const grams = new Intl.NumberFormat(locale, { maximumFractionDigits: abs < 10 ? 1 : 0 }).format(abs);
  return `${sign}${grams} g`;
}

/** A change: "−24 g", "+500 g", "±0 g". */
export function formatDelta(g: number, locale = 'en-LK'): string {
  if (Math.abs(g) < 0.05) return '±0 g';
  return g > 0 ? `+${formatGrams(g, locale)}` : formatGrams(g, locale);
}

export type Tone = 'teal' | 'info' | 'caution' | 'red' | 'muted';

/** Colour of a reading's card. Status colours never change with the theme (rule 11). */
export function statusTone(s: ReadingStatus | 'pruned'): Tone {
  switch (s) {
    case 'consumed':
    case 'refilled':
    case 'decided':
    case 'tare_set':
      return 'teal';
    case 'no_change':
      return 'muted';
    case 'needs_decision':
    case 'unknown_tag':
      return 'info';
    case 'below_tare':
    case 'no_tare':
    case 'no_product':
    case 'superseded':
    case 'no_tag':
      return 'caution';
    case 'error':
      return 'red';
    default:
      return 'muted';
  }
}

/** Readings someone has to act on (pop-up stays until handled). */
export function needsAction(s: string): boolean {
  return s === 'needs_decision' || s === 'unknown_tag' || s === 'no_tare' || s === 'no_product';
}

/**
 * How long from the stable weight to the card on this screen, in ms — the done-when's "within 2 s".
 * `at` is the scale's own clock, so a clock that's off makes this off too; estimated times are skipped.
 */
export function latencyMs(atIso: string, shownAt: number, estimated: boolean): number | null {
  if (estimated) return null;
  const ms = shownAt - Date.parse(atIso);
  return Number.isFinite(ms) && ms >= 0 && ms < 600_000 ? ms : null;
}

/** "1.3 s" / "850 ms". */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "Last seen" health: online if it synced in the last 90 s (it syncs every 30 s). */
export function deviceOnline(lastSeenIso: string | null, now = Date.now()): boolean {
  return !!lastSeenIso && now - Date.parse(lastSeenIso) < 90_000;
}

/** Wi-Fi strength in words for Diagnostics. */
export function wifiQuality(rssi: number | null | undefined): 'good' | 'fair' | 'weak' | 'unknown' {
  if (rssi == null) return 'unknown';
  if (rssi >= -60) return 'good';
  if (rssi >= -72) return 'fair';
  return 'weak';
}
