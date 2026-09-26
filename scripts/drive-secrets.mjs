// Stores the Google service account that reads the Bill Scanner's Drive folder (drive-scan Edge
// Function, Phase 7) as Edge Function secrets of one Supabase project — straight from the key file
// Google downloaded, with the Supabase CLI. The private key is never printed; it goes through a
// temporary env file that is deleted again (a long value on the Windows command line gets mangled).
// It must never go into apps/web, git or Vercel.
//
// Usage: node scripts/drive-secrets.mjs staging|prod "C:\path\to\gedara-xxxx.json"
// Afterwards delete the downloaded .json (Google can make a new key any time).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const refs = { staging: 'ebtvpsrehwdxepayqwma', prod: 'ltzlsxupcsamwtgqfejg' };
const [target, keyPath] = process.argv.slice(2);
if (!refs[target] || !keyPath) {
  console.error('Usage: node scripts/drive-secrets.mjs staging|prod "<path to the downloaded key .json>"');
  process.exit(2);
}

let key;
try {
  key = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch {
  console.error(`Couldn't read ${keyPath} as a JSON key file. Nothing was saved.`);
  process.exit(2);
}
const email = key?.client_email;
const pem = key?.private_key;
if (
  key?.type !== 'service_account' ||
  typeof email !== 'string' ||
  !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email) ||
  typeof pem !== 'string' ||
  !pem.includes('BEGIN PRIVATE KEY')
) {
  console.error('That file is not a Google service-account key (JSON). Nothing was saved.');
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), 'gedara-secrets-'));
const envFile = path.join(dir, 'drive.env');
writeFileSync(envFile, `GOOGLE_SA_EMAIL=${email}\nGOOGLE_SA_KEY=${Buffer.from(pem, 'utf8').toString('base64')}\n`, { mode: 0o600 });

console.log(`Setting the Drive reader on ${target} (${refs[target]}) …`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  execFileSync(npx, ['supabase', 'secrets', 'set', '--project-ref', refs[target], '--env-file', envFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
} catch {
  console.error('\nThe Supabase CLI could not set the secrets (are you logged in? `npx supabase login`). Nothing was saved.');
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!process.exitCode) {
  console.log(`Done. Share the Drive folder with ${email} (Viewer) if you haven't yet.`);
  console.log(`Check: https://${refs[target]}.supabase.co/functions/v1/drive-scan needs sign-in; the app's Diagnostics shows "configured".`);
}
