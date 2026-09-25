// Makes a VAPID key pair for Web Push (one pair per Supabase project) and stores it straight away as
// Edge Function secrets with the Supabase CLI. The private key is never printed or written to a
// file (no copy-paste, so it can't be broken across lines or end up in a chat); it must never go
// into apps/web, git or Vercel.
//
// Usage: node scripts/vapid-keys.mjs staging|prod
// Running it again makes NEW keys: every device then has to turn notifications off and on again.
import { execFileSync } from 'node:child_process';

const refs = { staging: 'ebtvpsrehwdxepayqwma', prod: 'ltzlsxupcsamwtgqfejg' };
const target = process.argv[2];
if (!refs[target]) {
  console.error('Usage: node scripts/vapid-keys.mjs staging|prod');
  process.exit(2);
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

console.log(`Setting new VAPID keys on ${target} (${refs[target]}) …`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  execFileSync(
    npx,
    [
      'supabase',
      'secrets',
      'set',
      '--project-ref',
      refs[target],
      `VAPID_PUBLIC_KEY=${publicKey}`,
      `VAPID_PRIVATE_KEY=${privateKey}`,
      'VAPID_SUBJECT=mailto:ayeshmantha1991.24@gmail.com',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
  );
} catch {
  console.error('\nThe Supabase CLI could not set the secrets (are you logged in? `npx supabase login`). Nothing was saved.');
  process.exit(1);
}
console.log(`Done. Public key (safe to share): ${publicKey}`);
console.log(`Check: https://${refs[target]}.supabase.co/functions/v1/attention-push should show this key.`);
