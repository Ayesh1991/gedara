import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.2 fix on staging: a BOC Flex Tap & Pay alert saved as its own expense while its scanned bill
// waits in "to be matched" → Check past bookings "counted twice" → Fix keeps the bill (moved to the
// wallet) and links the alert to it; the alert's own entry is gone.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-RL ';
const runs = new Map<string, string[]>();

test.afterAll(async ({}, testInfo) => {
  const ids = runs.get(testInfo.project.name);
  if (!ids) return;
  const admin = stagingAdmin();
  const { data: alerts } = await admin.from('sms_message').select('id').in('account_id', ids);
  const smsIds = (alerts ?? []).map((a) => a.id);
  if (smsIds.length) {
    const sug = await admin.from('match_suggestion').delete().in('sms_id', smsIds);
    if (sug.error) throw sug.error;
  }
  const s = await admin.from('sms_message').delete().in('account_id', ids);
  if (s.error) throw s.error;
  const txs = await admin.from('money_transaction').delete().in('account_id', ids);
  if (txs.error) throw txs.error;
  const acc = await admin.from('account').delete().in('id', ids);
  if (acc.error) throw acc.error;
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
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

test('a Tap & Pay alert and its scanned bill become one entry', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const phone = testInfo.project.name.startsWith('phone');
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  // letters only in alert text: a stray 4–8-digit number would be dropped as a possible OTP
  const TAG = Date.now().toString(36).toUpperCase().replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]!);
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d4 = '';
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));
  const wallet = `${PREFIX}Wallet ${tag}`;
  const holding = `${PREFIX}To be matched ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: household, name: wallet, kind: 'wallet', institution: 'BOC Flex', last4: d4, credit_limit: null, opening_balance: 50000, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: holding, kind: 'credit_card', institution: null, last4: null, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: true },
  ]).select('id, name');
  if (acc.error) throw acc.error;
  const id = (n: string) => acc.data.find((a) => a.name === n)!.id;
  runs.set(testInfo.project.name, acc.data.map((a) => a.id));

  const amount = (phone ? 3100 : 3600) + Math.floor(Math.random() * 400);
  const now = Date.now();
  const day = new Date(now - 3 * 3600e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const db = userClient();
  const { data: other } = await admin.from('category').select('id').eq('household_id', household).eq('key', 'other').is('parent_id', null).single();
  const stamp = Date.now().toString(36);
  const bill = await db.rpc('rpc_save_transaction', { p: {
    household_id: household, type: 'expense', account_id: id(holding), payee_text: `SHOP ${TAG}`, occurred_on: day, total: amount,
    fingerprint: `mrl${stamp}`, lines: [{ raw_name: `ITEM ${TAG}`, category_id: other!.id, amount, fingerprint: `mrl${stamp}-0-x` }],
  } });
  if (bill.error) throw bill.error;
  const billId = (bill.data as { id: string }).id;

  const body = `Your Tap & Pay transaction of LKR ${amount}.00 from XXXX${d4} at SHOP ${TAG} was successful. Ref: VC_${TAG.slice(0, 4)}7760`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="1">
<sms protocol="0" address="BOCONLINE" date="${now - 3 * 3600e3}" type="1" body="${esc(body)}" read="1" />
</smses>`;
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: /^Send 1 bank alerts? to the inbox$/ }).click();
  await expect(page.getByText(/1 new alerts? in the inbox, 0 were already there\./)).toBeVisible();

  // ── The inbox shows it (linking to the bill is unit-tested) ─────────────────
  await page.goto('/money/inbox');
  await expect(page.getByRole('listitem').filter({ hasText: `SHOP ${TAG}` }).first()).toBeVisible();

  // ── Saved as its own expense instead (as on prod) → Check past bookings ─────
  const { data: alert } = await admin.from('sms_message').select('id, occurred_on, fingerprint').eq('account_id', id(wallet)).single();
  const own = await db.rpc('rpc_sms_post', { p_sms_ids: [alert!.id], p: {
    household_id: household, type: 'expense', account_id: id(wallet), payee_text: `SHOP ${TAG}`, occurred_on: alert!.occurred_on, total: amount,
    lines: [{ raw_name: `SHOP ${TAG}`, category_id: other!.id, amount, fingerprint: `${alert!.fingerprint}-0-x` }],
  } });
  if (own.error) throw own.error;
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }
  await page.goto('/money/review');
  const row = page.getByRole('listitem').filter({ hasText: `SHOP ${TAG}` }).filter({ hasText: 'counted twice' });
  await expect(row.getByText('Fix keeps the bill with its items', { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/review').toBeLessThanOrEqual(0);
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect(row).toBeHidden();

  const { data: txs } = await admin.from('money_transaction').select('id, account_id').in('account_id', [id(wallet), id(holding)]);
  expect(txs).toEqual([expect.objectContaining({ id: billId, account_id: id(wallet) })]);
  const { data: linked } = await admin.from('sms_message').select('transaction_id').eq('id', alert!.id).single();
  expect(linked!.transaction_id).toBe(billId);
});
