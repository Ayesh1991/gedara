// Where the song is right now (Phase 7h). The speaker reports `elapsed_s` with the time Gedara
// received it (`at`) only when something changes; in between, the progress line runs on this clock,
// so it moves smoothly without the speaker sending anything.
export interface PlayerClock {
  state: 'stopped' | 'playing' | 'paused';
  elapsed_s: number;
  duration_s: number | null;
  at: string;
}

/** Seconds into the song at `now` (ms since epoch), never past its end. */
export function elapsedAt(p: PlayerClock, now: number): number {
  const base = Number(p.elapsed_s) || 0;
  const running = p.state === 'playing' ? Math.max(0, (now - Date.parse(p.at)) / 1000) : 0;
  const t = base + running;
  const d = p.duration_s == null ? null : Number(p.duration_s);
  return d != null && d > 0 ? Math.min(t, d) : t;
}

/** 0–1 along the song (0 when the length isn't known). */
export function fraction(p: PlayerClock, now: number): number {
  const d = p.duration_s == null ? 0 : Number(p.duration_s);
  return d > 0 ? Math.min(1, elapsedAt(p, now) / d) : 0;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Total length of songs, for a playlist ("1 h 12 min", "38 min"). */
export function formatLength(seconds: number, units: { h: string; min: string }): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} ${units.min}`;
  return `${Math.floor(m / 60)} ${units.h} ${m % 60} ${units.min}`;
}

/** Minutes left on a sleep timer, rounded up (null: no timer). */
export function sleepMinutesLeft(sleepUntil: string | null, now: number): number | null {
  if (!sleepUntil) return null;
  const left = Date.parse(sleepUntil) - now;
  return left > 0 ? Math.ceil(left / 60_000) : null;
}
