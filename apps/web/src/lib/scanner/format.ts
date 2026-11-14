// Bin-scanner numbers and wording (Phase 11). Pure: no Supabase import, so tests can use it.
// Amounts are in the product's stock unit: pieces stay a plain count, grams and millilitres read as
// kg / L from 1,000 up, and a pack with a size also says how many packs that is.
import type { ScanMode, ScanStatus } from '@scanner/protocol';

const MINUS = '−';
const COUNT_WORDS = new Set(['pack', 'packet', 'bottle', 'can', 'box', 'jar', 'bag', 'tin', 'cup', 'tub', 'roll', 'bar', 'sachet', 'tube']);

function num(n: number, locale: string, digits = 2): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
}

/** 5 pcs → "5", 800 ml → "800 ml", 1500 g → "1.5 kg". Never shows −0. */
export function formatAmount(qty: number, unit: string | null | undefined, locale = 'en-LK'): string {
  const abs = Math.abs(qty);
  const sign = qty < 0 && abs >= 0.00005 ? MINUS : '';
  const u = (unit ?? '').toLowerCase();
  if (u === 'pcs' || u === '') return `${sign}${num(abs, locale)}`;
  if ((u === 'g' || u === 'ml') && abs >= 1000) return `${sign}${num(abs / 1000, locale)} ${u === 'g' ? 'kg' : 'L'}`;
  // Counted in packs, bottles, cans …: "2 packs", "1 pack".
  const plural = COUNT_WORDS.has(u) && Math.abs(abs - 1) > 0.00005 ? 's' : '';
  return `${sign}${num(abs, locale, abs < 10 ? 1 : 0)} ${unit}${plural}`;
}

/** A change with its sign: "−1", "+400 ml". */
export function formatChange(qty: number, unit: string | null | undefined, locale = 'en-LK'): string {
  if (Math.abs(qty) < 0.00005) return `±${formatAmount(0, unit, locale)}`;
  return qty > 0 ? `+${formatAmount(qty, unit, locale)}` : formatAmount(qty, unit, locale);
}

/** How many whole packs are left, when the product has a pack size (800 ml of 400 ml packs → 2). */
export function packsLeft(left: number | null | undefined, pack: number | null | undefined, sized: boolean | null | undefined): number | null {
  if (!sized || left == null || !pack || pack <= 0) return null;
  const n = left / pack;
  return Math.abs(n - Math.round(n)) < 0.01 ? Math.round(n) : Math.round(n * 10) / 10;
}

export type Tone = 'teal' | 'info' | 'caution' | 'red' | 'muted';

/** Colour of a scan's card. Status colours never change with the theme (rule 11). */
export function statusTone(s: ScanStatus | 'pruned'): Tone {
  switch (s) {
    case 'used':
    case 'added':
    case 'opened':
    case 'moved':
      return 'teal';
    case 'unknown':
    case 'bill_guard':
    case 'no_stock':
      return 'info';
    case 'wasted':
    case 'held':
    case 'nothing_to_open':
    case 'not_pantry':
    case 'undo_none':
      return 'caution';
    case 'error':
      return 'red';
    default:
      return 'muted';
  }
}

/** Scans a person has to act on (the pop-up stays until handled). */
export function needsYou(s: string): boolean {
  return s === 'unknown' || s === 'bill_guard' || s === 'held';
}

/** Scans with an Undo button. */
export function canUndoScan(s: { status: string; undone_at: string | null; kind: string }): boolean {
  return s.kind === 'scan' && !s.undone_at && ['used', 'wasted', 'opened', 'added', 'moved', 'no_stock'].includes(s.status);
}

export const MODE_KEYS: Record<ScanMode, string> = { use: 'A', add: 'B', open: 'C', waste: 'D', check: '#' };

/** Online = heard from in the last 35 minutes (the scanner's heartbeat is every 30). */
export function scannerOnline(lastSeenAt: string | null, now = Date.now()): boolean {
  return !!lastSeenAt && now - new Date(lastSeenAt).getTime() < 35 * 60_000;
}

/** A key map is the 16 keys row by row, each exactly once. */
export function keymapValid(k: string): boolean {
  return /^[0-9A-D*#]{16}$/.test(k) && new Set(k).size === 16;
}

/** The same keypad with its ribbon plugged in the other way round, or rows and columns swapped. */
export function keymapVariants(): { id: 'normal' | 'swapped' | 'reversed' | 'swappedReversed'; map: string }[] {
  const base = ['123A', '456B', '789C', '*0#D'];
  const at = (r: number, c: number) => base[r]![c]!;
  const build = (f: (r: number, c: number) => string) =>
    [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => f(r, c)).join('')).join('');
  return [
    { id: 'normal', map: build((r, c) => at(r, c)) },
    { id: 'swapped', map: build((r, c) => at(c, r)) },
    { id: 'reversed', map: build((r, c) => at(3 - r, 3 - c)) },
    { id: 'swappedReversed', map: build((r, c) => at(3 - c, 3 - r)) },
  ];
}

/** The light setting as the scanner reads it: light_mode, else the older on/off (= always / off), else auto. */
export function lightModeOf(s: { light?: boolean; light_mode?: 'auto' | 'always' | 'off' }): 'auto' | 'always' | 'off' {
  if (s.light_mode) return s.light_mode;
  if (s.light === undefined) return 'auto';
  return s.light ? 'always' : 'off';
}
