// Swipe on pantry cards (MASTER_PLAN §5.2, deferred from Phase 3, opt-in in Settings): right = use
// the quick amount, left = use all, long-press = the actions menu. Pure decisions, unit-tested; the
// pointer wiring lives in components/pantry/useSwipe.ts.

/** Movement before we decide between "scrolling the list" and "swiping the card". */
export const LOCK_PX = 10;
/** Hold this long without moving = long-press. */
export const LONG_PRESS_MS = 500;
/** A long-press is cancelled by moving more than this. */
export const PRESS_SLOP_PX = 8;

export type Axis = 'none' | 'x' | 'y';

/** Which way the gesture goes, once it has moved enough; vertical wins ties (the list scrolls). */
export function lockAxis(dx: number, dy: number): Axis {
  if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return 'none';
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
}

/** How far to swipe: 35 % of the card, between 72 and 140 px. */
export function threshold(width: number): number {
  return Math.min(140, Math.max(72, width * 0.35));
}

export type SwipeResult = 'right' | 'left' | null;

/** On release: past the threshold in one direction fires that action; anything less snaps back. */
export function releaseAction(dx: number, width: number, allow: { right: boolean; left: boolean }): SwipeResult {
  const t = threshold(width);
  if (dx >= t && allow.right) return 'right';
  if (dx <= -t && allow.left) return 'left';
  return null;
}

/** The card follows the finger, with resistance past the threshold (and none in a blocked direction). */
export function dragOffset(dx: number, width: number, allow: { right: boolean; left: boolean }): number {
  if ((dx > 0 && !allow.right) || (dx < 0 && !allow.left)) return 0;
  const t = threshold(width);
  const a = Math.abs(dx);
  const eased = a <= t ? a : t + (a - t) * 0.3;
  return Math.sign(dx) * Math.min(eased, width * 0.6);
}
