import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { billNameNorm } from '../../supabase/functions/_shared/match/normalise';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b on staging: an old bill line without a product, whose printed name the household already
// taught → a matching run (the same function pg_cron calls) suggests the product by rule → "Needs you"
// → Yes → the line has its product and NO stock was made. Settings › Matching shows the ladder.
// Everything carries the token "e2emt<p|i>…" and is removed afterwards.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `e2emt${project.startsWith('phone') ? 'p' : 'i'}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `%${token(testInfo.project.name)}%`;
  const tx = await admin.from('money_transaction').delete().like('payee_text', like);
  if (tx.error) throw tx.error;
  for (const [table, column] of [
    ['product_alias', 'alias_norm'],
    ['product', 'name'],
    ['account', 'name'],
    ['merchant', 'name'],
  ] as const) {
    const r = await admin.from(table).delete().like(column, like);
    if (r.error) throw r.error;
  }
});

function userClient() {
  const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const access = (JSON.parse(item!.value) as { access_token: string }).access_token;
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${access}` } },
  });
}

test('9b: a matching run suggests a product for an old line; Yes links it without stock', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const tag = `${token(testInfo.project.name)}${Date.now().toString(36)}`;
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id;
  const { data: units } = await db.from('unit').select('id, code').is('household_id', null);
  const grams = units!.find((u) => u.code === 'g')!.id;
  const { data: grocery, error: gErr } = await db.from('category').select('id').eq('household_id', household).eq('key', 'grocery').single();
  if (gErr) throw gErr;

  const acc = await db.from('account').insert({ household_id: household, name: `Cash ${tag}`, kind: 'cash' }).select('id').single();
  if (acc.error) throw acc.error;
  const prod = await db.from('product').insert({ household_id: household, name: `Basmati ${tag}`, stock_unit_id: grams }).select('id').single();
  if (prod.error) throw prod.error;
  const lineName = `B/RICE 5KG ${tag}`;
  const alias = await stagingAdmin()
    .from('product_alias')
    .insert({ household_id: household, alias_norm: billNameNorm(lineName), destiny: 'stock', product_id: prod.data.id });
  if (alias.error) throw alias.error;
  const fp = `b${tag}`;
  const bill = await db.rpc('rpc_import_bills', {
    p_household: household,
    p_bills: [{
      account_id: acc.data.id, payee_text: `Shop ${tag}`, occurred_on: '2026-09-01', total: 1500, source: 'scan', fingerprint: fp,
      lines: [{ line_no: 0, raw_name: lineName, category_id: grocery.id, amount: 1500, fingerprint: `${fp}-0-a` }],
    }],
  });
  if (bill.error) throw bill.error;

  // ── A run (the function pg_cron calls twice a day; "Check now" allows one a minute per household) ──
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 2) throw r.error;
    await page.waitForTimeout(62_000);
  }

  // ── Needs you: the rule's suggestion, accepted ──────────────────────────────
  await page.goto('/money/review');
  await expect(page.getByRole('heading', { name: 'Needs you', level: 1 })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: lineName });
  await expect(row.getByText(`This is Basmati ${tag}`)).toBeVisible();
  await expect(row.getByText(/99 % sure · Gedara's rules/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/review').toBeLessThanOrEqual(0);
  await row.getByRole('button', { name: 'Yes' }).click();
  await expect(row).toBeHidden();

  const admin = stagingAdmin();
  const { data: line } = await admin.from('transaction_line').select('id, product_id').eq('fingerprint', `${fp}-0-a`).single();
  expect(line!.product_id).toBe(prod.data.id);
  const { count } = await admin.from('stock_lot').select('id', { count: 'exact', head: true }).eq('transaction_line_id', line!.id);
  expect(count, 'no stock is invented for an old line').toBe(0);
  const { data: sug } = await admin.from('match_suggestion').select('status').eq('line_id', line!.id).single();
  expect(sug!.status).toBe('accepted');

  // ── Settings › Matching ─────────────────────────────────────────────────────
  await page.goto('/settings/matching');
  await expect(page.getByRole('heading', { name: 'Matching', level: 1 })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'AI suggestions' })).toBeVisible();
  await expect(page.getByText('openai/gpt-oss-120b')).toBeVisible();
  await expect(page.getByText(/The AI never sees an SMS text/)).toBeVisible();
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2, '/settings/matching').toBeLessThanOrEqual(0);
});
