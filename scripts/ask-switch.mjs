// Ask Gedara's emergency stop (Phase 10). Sets or removes the Edge Function secret ASK_OFF on one Supabase
// project: with ASK_OFF=1 the ask-gedara function refuses every question at once, before it touches the
// database or any AI — even if the app or the database is broken. The everyday switch is in the app
// (Settings › Ask Gedara, owner only); use this only when something is wrong.
//
// Usage: node scripts/ask-switch.mjs staging|prod off|on
//   off → stop Ask now        on → let Ask answer again (the owner's switch in the app still applies)
import { execFileSync } from 'node:child_process';

/** @type {Record<string, string>} */
const refs = { staging: 'ebtvpsrehwdxepayqwma', prod: 'ltzlsxupcsamwtgqfejg' };
const [target = '', state = ''] = process.argv.slice(2);
if (!refs[target] || !['off', 'on'].includes(state)) {
  console.error('Usage: node scripts/ask-switch.mjs staging|prod off|on');
  process.exit(2);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Supabase CLI pinned: 2.122.0 (2026-10-23) has no Windows build, and plain `npx supabase` picks the newest.
const args =
  state === 'off'
    ? ['--yes', 'supabase@2.121.0', 'secrets', 'set', 'ASK_OFF=1', '--project-ref', refs[target]]
    : ['--yes', 'supabase@2.121.0', 'secrets', 'unset', 'ASK_OFF', '--project-ref', refs[target]];
try {
  execFileSync(npx, args, { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  console.log(
    state === 'off'
      ? `\nAsk Gedara is STOPPED on ${target} ✓ (every question is refused). Turn it back on with: node scripts/ask-switch.mjs ${target} on`
      : `\nAsk Gedara may answer again on ${target} ✓ (if the owner's switch in Settings › Ask Gedara is on).`,
  );
} catch {
  console.error('\nThe Supabase CLI could not change the secret (are you logged in? `npx supabase login`). Nothing changed.');
  process.exitCode = 1;
}
