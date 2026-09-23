// Runs supabase/tests/database/*.test.sql against gedara-staging — no Docker, no DB password.
//
// Transport: `supabase db query --linked` (Management API over HTTPS, uses `supabase login`).
// That API returns only the last statement's result, so each test ends by RAISING its TAP output
// as an error. The raise aborts the transaction, which also guarantees nothing persists: no COMMIT
// is ever sent.
//
// Usage: pnpm test:db [--with-migrations] [file ...]
//   --with-migrations  apply the migrations NOT yet on the linked DB inside each test transaction.
//                      Proves them before `supabase db push` (applied migrations are immutable).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const stagingRef = process.env.E2E_STAGING_REF ?? '';
let linkedRef = '';
try {
  linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
} catch {
  // not linked
}
if (!stagingRef || linkedRef !== stagingRef) {
  console.error(
    `Refusing to run: linked project "${linkedRef || '(none)'}" is not E2E_STAGING_REF "${stagingRef || '(unset)'}".`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const withMigrations = args.includes('--with-migrations');
const fileArgs = args.filter((a) => !a.startsWith('--'));

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

/** Migration versions already applied to the linked project. */
function appliedVersions() {
  // Via a file: with shell=true on Windows an inline SQL argument would be split at spaces.
  const q = path.join(mkdtempSync(path.join(tmpdir(), 'gedara-sqlq-')), 'applied.sql');
  writeFileSync(q, 'select version from supabase_migrations.schema_migrations');
  const out = execFileSync(npx, ['supabase', 'db', 'query', '--linked', '-f', q], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  });
  return new Set([...out.matchAll(/"version":\s*"(\d+)"/g)].map((m) => m[1]));
}

let migrationsSql = '';
if (withMigrations) {
  const applied = appliedVersions();
  const pending = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql') && !applied.has(f.split('_')[0]))
    .sort();
  console.log(`Pending migrations applied in each test transaction: ${pending.join(', ') || '(none)'}`);
  migrationsSql = pending
    .map((f) => readFileSync(path.join('supabase/migrations', f), 'utf8'))
    .join('\n;\n');
}

const dir = 'supabase/tests/database';
const files = fileArgs.length
  ? fileArgs
  : readdirSync(dir)
      .filter((f) => f.endsWith('.test.sql'))
      .sort()
      .map((f) => path.join(dir, f));

const MARK = 'GEDARA_TAP';
// Every assertion's TAP text is inserted here (writable by whichever role the test switched to).
const CAPTURE = `
create temp table _gedara_tap (line text) on commit drop;
grant all on _gedara_tap to public;
`;
// One raise returns all captured lines plus the plan, and aborts the transaction.
const REPORT = `
reset role;
do $gedara$
begin
  raise exception '${MARK}%${MARK}', (
    select coalesce(string_agg(line, E'\\n'
             order by nullif(substring(line from '^(?:not )?ok (\\d+)'), '')::int), '')
      from _gedara_tap
  ) || E'\\n1..' || coalesce((select value from __tcache__ where label = 'plan' limit 1), 0);
end
$gedara$;
`;

const tmp = mkdtempSync(path.join(tmpdir(), 'gedara-sqltest-'));
let failedFiles = 0;

for (const file of files) {
  let body = readFileSync(file, 'utf8');
  if (!/^begin;\s*$/m.test(body)) {
    console.error(`${file}: tests must start with "begin;"`);
    process.exit(2);
  }
  // Function replacers: a string replacement would turn every `$$` in the SQL into `$`.
  body = body
    .replace(/^select \* from finish\(\);\s*$/m, () => '')
    .replace(/^rollback;\s*$/m, () => '')
    // Assertions are the column-0 `select`s (except plan); capture their TAP output.
    .replace(/^select (?!plan\()/gm, () => 'insert into _gedara_tap (line) select ')
    .replace(/^begin;\s*$/m, () => `begin;\n${withMigrations ? `${migrationsSql}\n;\n` : ''}${CAPTURE}`);
  const sqlPath = path.join(tmp, path.basename(file));
  writeFileSync(sqlPath, `${body}\n${REPORT}`);

  let output = '';
  try {
    output = execFileSync(npx, ['supabase', 'db', 'query', '--linked', '-f', sqlPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
  } catch (e) {
    const err = /** @type {{ stdout?: string, stderr?: string }} */ (e);
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  // Output is JSON with the error text escaped; unescape newlines before extracting.
  const flat = output.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\+"/g, '"');
  const m = new RegExp(`${MARK}([\\s\\S]*?)${MARK}`).exec(flat);
  const lines = m ? m[1].split('\n').filter(Boolean) : [];
  if (!m) {
    const err = /ERROR:\s+([^\n"]+)/.exec(flat)?.[1] ?? flat.trim().split('\n').slice(-3).join(' ');
    lines.push(`not ok - aborted before reporting: ${err}`);
  }

  const plan = lines.find((l) => l.startsWith('1..'));
  const planned = plan ? Number(plan.slice(3)) : NaN;
  const oks = lines.filter((l) => l.startsWith('ok ')).length;
  const notOks = lines.filter((l) => l.startsWith('not ok')).length;
  const pass = notOks === 0 && oks === planned && planned > 0;
  if (!pass) failedFiles++;

  console.log(`\n${pass ? 'PASS' : 'FAIL'} ${file} (${oks}/${Number.isNaN(planned) ? '?' : planned})`);
  for (const l of lines) if (!pass || l.startsWith('not ok')) console.log(`  ${l}`);
}

console.log(`\n${files.length - failedFiles}/${files.length} files passed`);
process.exit(failedFiles ? 1 : 0);
