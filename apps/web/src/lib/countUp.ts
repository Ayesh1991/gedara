export function easeOutCubic(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return 1 - (1 - c) ** 3;
}

/** Value shown `elapsedMs` into a count-up from 0 to `target`. */
export function countUpValue(target: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return target;
  return target * easeOutCubic(elapsedMs / durationMs);
}
