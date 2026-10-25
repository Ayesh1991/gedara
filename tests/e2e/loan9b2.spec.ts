import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.2 fix on staging, from prod:
//   * a loan's starting balance is what is owed (not "available credit" like a card): 0 before the payout
//     → Rs 2,000,000 owed after the Rs 2,000,000 payout, shown as "owed of the loan";
//   * a debit booked as spending that was really a repayment can be edited into a transfer
//     (Rs 500,000 to "Owed to brother").
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-LN ';
const runs = new Map<string, string[]>();

test.afterAll(async ({}, testInfo) => {
  const ids = runs.get(testInfo.project.name);
  if (!ids) return;
  const admin = stagingAdmin();
  const accts = ids.join(',');
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

test('a loan is entered as owed; a spending entry can become a transfer', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const admin = stagingAdmin();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const bank = `${PREFIX}Current ${tag}`;
  const loan = `${PREFIX}Loan ${tag}`;
  const brother = `${PREFIX}Owed to brother ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: household, name: bank, kind: 'bank', institution: 'BOC', last4: null, credit_limit: null, opening_balance: 0, opening_on: '2026-10-01', is_suspense: false },
    // as "New account seen" makes it: the loan amount as its limit, the starting balance wrongly as owed already
    { household_id: household, name: loan, kind: 'loan', institution: 'BOC', last4: null, credit_limit: 2000000, opening_balance: -2000000, opening_on: '2026-10-13', is_suspense: false },
    { household_id: household, name: brother, kind: 'loan', institution: null, last4: null, credit_limit: null, opening_balance: -500000, opening_on: '2026-10-23', is_suspense: false },
  ]).select('id, name');
  if (acc.error) throw acc.error;
  const id = (n: string) => acc.data.find((a) => a.name === n)!.id;
  runs.set(testInfo.project.name, acc.data.map((a) => a.id));

  const db = userClient();
  const payout = await db.rpc('rpc_save_transaction', { p: {
    household_id: household, type: 'transfer', account_id: id(loan), to_account_id: id(bank), occurred_on: '2026-10-14', total: 2000000,
    fingerprint: `mln${Date.now().toString(36)}a`, lines: [],
  } });
  if (payout.error) throw payout.error;
  const { data: cats } = await admin.from('category').select('id, key').eq('household_id', household).eq('key', 'other').is('parent_id', null).single();
  const paid = await db.rpc('rpc_save_transaction', { p: {
    household_id: household, type: 'expense', account_id: id(bank), payee_text: `Online Transfer Debit ${tag}`, occurred_on: '2026-10-24', total: 500000,
    fingerprint: `mln${Date.now().toString(36)}b`,
    lines: [{ raw_name: 'Online Transfer Debit', category_id: cats!.id, amount: 500000, fingerprint: `mln${Date.now().toString(36)}b-0-x` }],
  } });
  if (paid.error) throw paid.error;
  const paidId = (paid.data as { id: string }).id;

  // ── The loan: 4,000,000 shown; the starting balance is entered as owed → 2,000,000 ─────
  await page.goto(`/money/accounts/${id(loan)}`);
  await expect(page.getByText('LKR 4,000,000.00')).toBeVisible();
  await page.getByRole('button', { name: 'Change starting balance' }).click();
  await expect(page.getByLabel('Amount owed')).toBeVisible();
  await page.getByLabel('Amount owed').fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('LKR 2,000,000.00').first()).toBeVisible();
  await expect(page.getByText('Rs 2,000,000 owed of the Rs 2,000,000 loan')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'loan page').toBeLessThanOrEqual(0);

  // ── The Rs 500,000 "spending" becomes a transfer to Owed to brother ─────────
  await page.goto(`/money/tx/${paidId}`);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('tab', { name: 'Transfer' }).click();
  await page.locator('#money-to').selectOption({ label: brother });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeHidden();
  const { data: tx } = await admin.from('money_transaction').select('type, account_id, to_account_id').eq('id', paidId).single();
  expect(tx).toMatchObject({ type: 'transfer', account_id: id(bank), to_account_id: id(brother) });
  const { data: bal } = await admin.from('v_account_balance').select('balance').eq('account_id', id(brother)).single();
  expect(Number(bal!.balance)).toBe(0);
});
