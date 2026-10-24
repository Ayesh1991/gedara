import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.2 on staging, BOC Flex. An SMS backup with
//   * a BOCONLINE OTP (left out) and a Tap & Pay payment from the wallet ··NNNN → "New account seen: BOC Flex
//     ··NNNN · Wallet" → one tap adds it;
//   * two BOC alerts whose "Balance available" fell Rs X more than they explain (the wallet top-up sends no
//     SMS) → a matching run lists "probably a top-up of BOC Flex ··NNNN" under Check past bookings → Fix books
//     the transfer.
// The top-up guess needs exactly one wallet in the household, so only the phone run does this (the iPad
// run would add a second wallet at the same moment).
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-9B2 ';
const runs = new Map<string, { accounts: string[]; d4: string }>();

test.afterAll(async ({}, testInfo) => {
  const run = runs.get(testInfo.project.name);
  if (!run) return;
  const admin = stagingAdmin();
  const { data: wallets } = await admin.from('account').select('id').eq('institution', 'BOC Flex').eq('last4', run.d4);
  const ids = [...run.accounts, ...(wallets ?? []).map((w) => w.id)];
  const { data: alerts } = await admin.from('sms_message').select('id').in('account_id', ids);
  const smsIds = (alerts ?? []).map((a) => a.id);
  if (smsIds.length) {
    const sug = await admin.from('match_suggestion').delete().in('sms_id', smsIds);
    if (sug.error) throw sug.error;
  }
  for (const q of [
    admin.from('sms_message').delete().in('account_id', ids),
    admin.from('sms_message').delete().eq('sender', 'BOCONLINE').like('body', `%XXXX${run.d4}%`),
  ]) {
    const r = await q;
    if (r.error) throw r.error;
  }
  const accts = ids.join(',');
  const fees = await admin.from('money_transaction').delete().not('related_id', 'is', null).or(`account_id.in.(${accts}),to_account_id.in.(${accts})`);
  if (fees.error) throw fees.error;
  const txs = await admin.from('money_transaction').delete().or(`account_id.in.(${accts}),to_account_id.in.(${accts})`);
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

test('9b.2: BOC Flex Tap & Pay goes to the wallet; a top-up found from the bank balance is booked', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('phone'), 'one wallet per household: the phone run covers it');
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  // Letters only in alert text: a stray 4–8-digit number would be dropped as a possible OTP.
  const TAG = Date.now().toString(36).toUpperCase().replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]!);

  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d3 = '';
  let d4 = '';
  while (!d3 || used.has(d3)) d3 = String(100 + Math.floor(Math.random() * 900));
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));
  const bankName = `${PREFIX}BOC ${tag}`;
  const acc = await admin.from('account').insert({
    household_id: household, name: bankName, kind: 'bank', institution: 'BOC', last4: d3, credit_limit: null,
    opening_balance: 0, opening_on: '2026-01-01', is_suspense: false,
  }).select('id').single();
  if (acc.error) throw acc.error;
  const bank = acc.data.id;
  runs.set(testInfo.project.name, { accounts: [bank], d4 });

  const topup = 3000 + Math.floor(Math.random() * 40) * 100;
  const pay = 1200 + Math.floor(Math.random() * 300);
  const now = Date.now();
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="4">
${sms('BOC', now - 6 * 3600e3, `ATM Withdrawal Rs 1000.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs 50000.00 - Thank you for banking with BOC`)}
${sms('BOCONLINE', now - 5 * 3600e3, 'Dear Customer, Please use 503684 as your OTP for BOC Flex Wallet Online Transfer. This OTP is valid only for 2 minutes. DO NOT share this OTP with anyone.')}
${sms('BOCONLINE', now - 4 * 3600e3, `Your Tap & Pay transaction of LKR ${pay}.00 from XXXX${d4} at E2E SHOP ${TAG} was successful. Ref: VC_${TAG.slice(0, 4)}7760`)}
${sms('BOC', now - 3 * 3600e3, `ATM Withdrawal Rs 2000.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs ${48000 - topup}.00 - Thank you for banking with BOC`)}
</smses>`;

  // ── 1. Import: the BOC Flex OTP stays out, the Tap & Pay payment comes in ───
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 3 bank alerts to the inbox' }).click();
  await expect(page.getByText(/3 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // ── 2. New account seen: the wallet, added in one tap ───────────────────────
  await page.goto('/money/inbox');
  await expect(page.getByRole('heading', { name: 'Bank alerts', level: 1 })).toBeVisible();
  const seen = page.getByRole('listitem').filter({ hasText: `New account seen: BOC Flex ··${d4}` });
  await expect(seen.getByText('Wallet · 1 alert waiting')).toBeVisible();
  await seen.getByRole('button', { name: 'Add account' }).click();
  await expect(seen).toBeHidden();
  const { data: wallet, error: wErr } = await admin.from('account').select('id, kind, name').eq('institution', 'BOC Flex').eq('last4', d4).single();
  if (wErr) throw wErr;
  expect(wallet).toMatchObject({ kind: 'wallet', name: `BOC Flex ··${d4}` });
  await expect(page.getByRole('listitem').filter({ hasText: `E2E SHOP ${TAG}` }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/inbox').toBeLessThanOrEqual(0);

  // ── 3. A matching run finds the top-up the balance shows ────────────────────
  const db = userClient();
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }

  await page.goto('/money/review');
  await expect(page.getByRole('heading', { name: 'Check past bookings', level: 2 })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: bankName }).filter({ hasText: 'probably a top-up of' });
  await expect(row.getByText(`probably a top-up of BOC Flex ··${d4} (it sends no SMS)`, { exact: false })).toBeVisible();
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2, '/money/review').toBeLessThanOrEqual(0);
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect(row).toBeHidden();

  const { data: tr, error: tErr } = await admin.from('money_transaction').select('type, total, account_id, to_account_id')
    .eq('account_id', bank).eq('to_account_id', wallet.id).single();
  if (tErr) throw tErr;
  expect(tr.type).toBe('transfer');
  expect(Number(tr.total)).toBe(topup);
});
