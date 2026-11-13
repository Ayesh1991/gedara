// Telling "Sign out" (the person asked: everything of theirs leaves the device) apart from a login
// that ran out (Quick spend entries still waiting must survive it). Phase 12.
const KEY = 'gedara:signout-asked';

/** Call right before supabase.auth.signOut() when the person tapped Sign out. */
export function markSignOutAsked() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // storage blocked: treated as a login that ran out (entries are kept, which is the safe side)
  }
}

/** True once after markSignOutAsked(). */
export function takeSignOutAsked(): boolean {
  try {
    const asked = sessionStorage.getItem(KEY) === '1';
    sessionStorage.removeItem(KEY);
    return asked;
  } catch {
    return false;
  }
}
