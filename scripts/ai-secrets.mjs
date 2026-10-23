// Stores the AI keys for matching (match-agent Edge Function, Phase 9b) as Edge Function secrets of one
// Supabase project. Each key is typed (pasted) into a hidden prompt — nothing is shown on screen — and
// checked with the provider's free "list models" call before anything is saved. The keys go through a
// temporary env file that is deleted again, never on a command line, and are never printed.
// They must never go into apps/web, git, Vercel or a chat.
//
// Usage: node scripts/ai-secrets.mjs staging|prod
// Press Enter on an empty prompt to leave that key as it is.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @type {Record<string, string>} */
const refs = { staging: 'ebtvpsrehwdxepayqwma', prod: 'ltzlsxupcsamwtgqfejg' };
const target = process.argv[2] ?? '';
if (!refs[target]) {
  console.error('Usage: node scripts/ai-secrets.mjs staging|prod');
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error('Run this in a terminal window: it asks for each key in a hidden prompt.');
  process.exit(2);
}

/**
 * @typedef {{ name: string, secret: string, where: string, check: (key: string) => Promise<number> }} Provider
 * @type {Provider[]}
 */
const providers = [
  {
    name: 'Groq',
    secret: 'GROQ_API_KEY',
    where: 'console.groq.com › API Keys',
    check: async (key) => (await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } })).status,
  },
  {
    name: 'Google Gemini',
    secret: 'GEMINI_API_KEY',
    where: 'aistudio.google.com › Get API key (the project with billing on)',
    check: async (key) =>
      (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } })).status,
  },
  {
    name: 'OpenAI',
    secret: 'OPENAI_API_KEY',
    where: 'platform.openai.com › API keys',
    check: async (key) => (await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } })).status,
  },
];

/**
 * Reads one line without showing it (a dot per character, so a paste can be seen to have arrived).
 * @param {string} question
 * @returns {Promise<string>}
 */
function hidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\nStopped. Nothing was saved.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

console.log(`AI keys for Gedara matching on ${target} (${refs[target]}).`);
console.log('Paste each key and press Enter (nothing is shown). Empty + Enter keeps the key as it is.\n');

/** @type {string[]} */
const lines = [];
for (const p of providers) {
  for (;;) {
    const key = await hidden(`${p.name} key (${p.where}): `);
    if (!key) {
      console.log(`  ${p.name}: left as it is.`);
      break;
    }
    if (!/^[\x21-\x7e]{20,300}$/.test(key)) {
      console.log('  That doesn\'t look like a key (spaces or odd characters). Try again, or Enter to skip.');
      continue;
    }
    let status = 0;
    try {
      status = await p.check(key);
    } catch {
      status = -1;
    }
    if (status === 200) {
      lines.push(`${p.secret}=${key}`);
      console.log(`  ${p.name}: key works ✓`);
      break;
    }
    console.log(
      status === -1
        ? `  ${p.name}: couldn't reach the provider (internet?). Try again, or Enter to skip.`
        : `  ${p.name}: the provider refused this key (HTTP ${status}). Try again, or Enter to skip.`,
    );
  }
}

if (!lines.length) {
  console.log('\nNo key to save. Nothing changed.');
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'gedara-ai-'));
const envFile = path.join(dir, 'ai.env');
writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
lines.length = 0;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Supabase CLI pinned: 2.122.0 (2026-10-23) has no Windows build, and plain `npx supabase` picks the newest.
try {
  execFileSync(npx, ['--yes', 'supabase@2.121.0', 'secrets', 'set', '--project-ref', refs[target], '--env-file', envFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  console.log(`\nSaved ✓ on ${target}. Gedara › Settings › Matching › "Test the AI keys" shows each model.`);
} catch {
  console.error('\nThe Supabase CLI could not set the secrets (are you logged in? `npx supabase login`). Nothing was saved.');
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
