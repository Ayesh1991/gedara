import { z } from 'zod';
import { DEFAULT_THEME, THEME_IDS } from './themes';

// Appearance preferences. Stored per user in Supabase Auth user_metadata.prefs (syncs across
// devices) and mirrored in localStorage so the right theme paints before login and before React.

export const MOTION_MODES = ['system', 'on', 'off'] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

// user_metadata is user-editable JSON — validate it (rule 6); anything unknown falls back.
export const PrefsSchema = z.object({
  theme: z.enum(THEME_IDS).catch(DEFAULT_THEME),
  motion: z.enum(MOTION_MODES).catch('system'),
  /** ms since epoch of the last change; the newer side wins when devices disagree. 0 = never set. */
  updatedAt: z.number().int().nonnegative().catch(0),
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const DEFAULT_PREFS: Prefs = { theme: DEFAULT_THEME, motion: 'system', updatedAt: 0 };

export function parsePrefs(raw: unknown): Prefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS;
  return PrefsSchema.parse(raw);
}

// Keep in sync with the pre-paint script in index.html.
export const PREFS_STORAGE_KEY = 'gedara:prefs';

export function readLocalPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    return raw ? parsePrefs(JSON.parse(raw)) : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeLocalPrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // private mode / storage blocked — the in-memory state still applies
  }
}

export function applyPrefs(prefs: Prefs, root: HTMLElement = document.documentElement) {
  root.dataset.theme = prefs.theme;
  root.dataset.motion = prefs.motion;
}

/** Whether animations should run: explicit on/off wins; "system" follows the OS setting. */
export function resolveMotion(mode: MotionMode, systemReducesMotion: boolean): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !systemReducesMotion;
}

/**
 * Local (this device) vs account prefs on start-up. Newer wins: adopt the account's if it's newer;
 * push ours if ours is newer (e.g. a save interrupted by a reload), otherwise leave both alone.
 */
export function reconcile(local: Prefs, remote: Prefs | null): { adopt: Prefs | null; push: boolean } {
  if (!remote) return { adopt: null, push: local.updatedAt > 0 };
  if (remote.updatedAt > local.updatedAt) return { adopt: remote, push: false };
  return { adopt: null, push: local.updatedAt > remote.updatedAt };
}
