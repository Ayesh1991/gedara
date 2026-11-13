// Quick spend (Phase 12): which tiles come first, what a tile's usual amount is, the typo guard and
// the number pad. Pure functions, no AI: counted from the person's own entries of the last 60 days.

export interface TileLike {
  id: string;
  key: string | null;
  sort: number;
  hidden: boolean;
  usual_amount: number | null;
}

/** One past entry: which tile, how much, when it was tapped (ISO). */
export interface Use {
  tile_id: string | null;
  amount: number;
  at: string;
}

const DAY = 86_400_000;
/** A use counts fully for 3 weeks' worth of recency, then fades. */
const HALF_LIFE_DAYS = 21;
/** The amount pad stops here (the database refuses more as well: GDQAM). */
export const HARD_STOP = 200_000;
/** Above this, a tile asks for a second tap. */
export const ASK_ABOVE = 5_000;

/** Hours between two clock hours, around midnight (23 ↔ 1 = 2). */
export function hourGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

/** How much one past use says about "now": recent counts more, the same time of day much more. */
export function weightOfUse(useAt: Date, useHour: number, now: Date, nowHour: number): number {
  const age = Math.max(0, (now.getTime() - useAt.getTime()) / DAY);
  const recency = Math.pow(0.5, age / HALF_LIFE_DAYS);
  const gap = hourGap(useHour, nowHour);
  const near = gap <= 1 ? 3 : gap <= 3 ? 1.5 : 0;
  return recency * (1 + near);
}

/**
 * Shown tiles in order. `learned`: most used at this time of day first (ties and unused tiles keep
 * the person's own order). `mine`: exactly the person's order. "Other" is always last.
 * `hourOf` gives the household-timezone hour of a date.
 */
export function rankTiles<T extends TileLike>(
  tiles: readonly T[],
  uses: readonly Use[],
  now: Date,
  hourOf: (d: Date) => number,
  mode: 'learned' | 'mine',
): T[] {
  const shown = tiles.filter((t) => !t.hidden);
  const score = new Map<string, number>();
  if (mode === 'learned') {
    const nowHour = hourOf(now);
    for (const u of uses) {
      if (!u.tile_id) continue;
      const at = new Date(u.at);
      if (Number.isNaN(at.getTime())) continue;
      score.set(u.tile_id, (score.get(u.tile_id) ?? 0) + weightOfUse(at, hourOf(at), now, nowHour));
    }
  }
  const last = (t: T) => (t.key === 'other' ? 1 : 0);
  return [...shown].sort(
    (a, b) => last(a) - last(b) || (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || a.sort - b.sort || a.id.localeCompare(b.id),
  );
}

/** The amount a tile is usually used with: the same amount on at least 3 of its last 5 uses. */
export function learnedAmount(tileId: string, uses: readonly Use[]): number | null {
  const mine = uses
    .filter((u) => u.tile_id === tileId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
  const count = new Map<number, number>();
  for (const u of mine) count.set(u.amount, (count.get(u.amount) ?? 0) + 1);
  let best: number | null = null;
  for (const [amount, n] of count) if (n >= 3 && (best === null || n > count.get(best)!)) best = amount;
  return best;
}

export interface Favourite<T> {
  tile: T;
  amount: number;
}

/** One-tap favourites ("Tea 100"): ranked tiles that have a usual amount (set by hand, else learned). */
export function favourites<T extends TileLike>(ranked: readonly T[], uses: readonly Use[], max = 4): Favourite<T>[] {
  const out: Favourite<T>[] = [];
  for (const tile of ranked) {
    const amount = tile.usual_amount ?? learnedAmount(tile.id, uses);
    if (amount !== null && amount > 0) out.push({ tile, amount });
    if (out.length === max) break;
  }
  return out;
}

/**
 * The typo guard. `stop`: not possible here. `ask`: the tile asks for a second tap (a big amount,
 * or far above what this tile is usually used with). No pop-up either way.
 */
export function guard(amount: number, usual: number | null): 'ok' | 'ask' | 'stop' {
  if (!(amount > 0) || amount > HARD_STOP) return 'stop';
  if (amount > ASK_ABOVE) return 'ask';
  if (usual !== null && amount >= 1000 && amount > usual * 5) return 'ask';
  return 'ok';
}

export type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'back' | 'clear';

/** The amount as typed (whole rupees, up to 6 digits, no leading zeros). */
export function padPress(current: string, key: PadKey): string {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  const next = (current + key).replace(/^0+/, '');
  return next.length > 6 ? current : next;
}
