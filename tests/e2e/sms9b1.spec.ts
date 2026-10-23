import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.1 on staging, evidence before guesses. An SMS backup with
//   * a BOC "Online Transfer Debit" and Dialog's (5555) confirmation of the same amount → the inbox says
//     "Dialog plan confirms this payment" and picks Mobile & telephone; the confirmation is a note;
//   * a BOC "CEFT Transfer Debit Rs X+25" and a Sampath card "PAYMENT RECEIVED Rs X" → the debit is booked
//     (wrongly) as Banking & fees spending, a matching run lists it under "Check past bookings", and Fix
//     turns it into a transfer to the card plus a Rs 25 fee, both alerts linked.
// Accounts carry their own prefix; random amounts keep the phone and iPad runs apart.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-9B1 ';
const runs = new Map<string, { accounts: string[]; receipt: string }>();

test.afterAll(async ({}, testInfo) => {
  const run = runs.get(testInfo.project.name);
  if (!run) return;
  const admin = stagingAdmin();
  const { data: alerts } = await admin.from('sms_message').select('id').in('account_id', run.accounts);
  const smsIds = (alerts ?? []).map((a) => a.id);
  if (smsIds.length) {
    const sug = await admin.from('match_suggestion').delete().in('sms_id', smsIds);
    if (sug.error) throw sug.error;
  }
  for (const q of [
    admin.from('sms_message').delete().in('account_id', run.accounts),
    admin.from('sms_message').delete().eq('sender', '5555').like('body', run.receipt),
  ]) {
    const r = await q;
    if (r.error) throw r.error;
  }
  const accts = run.accounts.join(',');
  const fees = await admin.from('money_transaction').delete().not('related_id', 'is', null).or(`account_id.in.(${accts}),to_account_id.in.(${accts})`);
  if (fees.error) throw fees.error;
  const txs = await admin.from('money_transaction').delete().or(`account_id.in.(${accts}),to_account_id.in.(${accts})`);
  if (txs.error) throw txs.error;
  const acc = await admin.from('account').delete().in('id', run.accounts);
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

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const lkr = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });

test('9b.1: a payee confirms a payment; a past booking the evidence contradicts is fixed', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const project = testInfo.project.name;
  const phone = project.startsWith('phone');
  const tag = `${project}-${Date.now().toString(36)}`;

  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: cats, error: cErr } = await admin.from('category').select('id, name, parent_id, key').eq('household_id', household);
  if (cErr) throw cErr;
  const services = cats.find((c) => c.key === 'services' && !c.parent_id)!;
  const fees = cats.find((c) => c.parent_id === services.id && c.name === 'Banking & fees')!;
  const mobile = cats.find((c) => c.parent_id === services.id && c.name === 'Mobile & telephone')!;

  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d3 = '';
  let d4 = '';
  while (!d3 || used.has(d3)) d3 = String(100 + Math.floor(Math.random() * 900));
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));
  const bankName = `${PREFIX}BOC ${tag}`;
  const cardName = `${PREFIX}Sampath card ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: household, name: bankName, kind: 'bank', institution: 'BOC', last4: d3, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: cardName, kind: 'credit_card', institution: 'Sampath', last4: d4, credit_limit: 300000, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
  ]).select('id, kind');
  if (acc.error) throw acc.error;
  const bank = acc.data.find((a) => a.kind === 'bank')!.id;
  const card = acc.data.find((a) => a.kind === 'credit_card')!.id;

  const dialogAmt = (phone ? 300 : 550) + Math.floor(Math.random() * 240);
  const paid = (phone ? 21000 : 23000) + Math.floor(Math.random() * 900);
  runs.set(project, { accounts: [bank, card], receipt: `%activated the Rs.${dialogAmt} Any Network%` });

  const now = Date.now();
  const today = new Date(now + 5.5 * 3600e3);
  const ddMon = `${String(today.getUTCDate()).padStart(2, '0')}-${MONTHS[today.getUTCMonth()]}`;
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="4">
${sms('BOC', now - 5 * 3600e3, `CEFT Transfer Debit Rs ${paid + 25}.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs 40000.00 - Thank you for banking with BOC`)}
${sms('SAMPCCTXN', now - 4 * 3600e3, `Cr Crd no..**${d4} Credited LKR ${lkr(paid)} for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 129,517.96 Enq Call 0112300604 - Sampath Bank ${ddMon}`)}
${sms('BOC', now - 3 * 3600e3, `Online Transfer Debit Rs ${dialogAmt}.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs 39000.00 - Thank you for banking with BOC`)}
${sms('5555', now - 3 * 3600e3 + 60_000, `You have successfully activated the Rs.${dialogAmt} Any Network Voice plan with 250 mins to Any net (Including local landlines) & 250 Any net SMS, valid for 30 days. Visit https://dlg.lk/mdprp or dial #111#`)}
</smses>`;

  // ── 1. Import: the Dialog confirmation is kept with the bank alerts ─────────
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 4 bank alerts to the inbox' }).click();
  await expect(page.getByText(/4 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // ── 2. Inbox: the payee's confirmation names the debit; it is a note itself ──
  await page.goto('/money/inbox');
  await expect(page.getByRole('heading', { name: 'Bank alerts', level: 1 })).toBeVisible();
  // (an item's account picker lists every account, so items are told apart by their amount)
  const amountText = new RegExp(`(?<![\\d,])${lkr(dialogAmt).replace('.', '\\.')}(?!\\d)`);
  const debit = page.getByRole('listitem').filter({ hasText: 'Online Transfer Debit' }).filter({ hasText: amountText })
    .filter({ hasText: 'Dialog plan confirms this payment' });
  await expect(debit).toBeVisible();
  await expect(debit.getByRole('combobox', { name: 'Category' })).toHaveValue(mobile.id);
  const receipt = page.getByRole('listitem').filter({ hasText: "A payee's confirmation" }).filter({ hasText: amountText });
  await expect(receipt.getByText('It explains the bank alert of the same amount', { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/inbox').toBeLessThanOrEqual(0);

  // ── 3. The CEFT debit was booked as spending (as it once was on prod) ──────
  const db = userClient();
  const { data: ceft, error: sErr } = await admin.from('sms_message').select('id, fingerprint, occurred_on, occurred_at')
    .eq('account_id', bank).eq('amount', paid + 25).single();
  if (sErr) throw sErr;
  const { data: payment, error: pErr } = await admin.from('sms_message').select('id').eq('account_id', card).eq('kind', 'card_payment').single();
  if (pErr) throw pErr;
  const wrong = await db.rpc('rpc_sms_post', {
    p_sms_ids: [ceft.id],
    p: {
      household_id: household, type: 'expense', account_id: bank, payee_text: 'CEFT Transfer Debit', occurred_on: ceft.occurred_on,
      occurred_at: ceft.occurred_at, total: paid + 25,
      lines: [{ raw_name: 'CEFT Transfer Debit', category_id: fees.id, amount: paid + 25, fingerprint: `${ceft.fingerprint}-0-e2e` }],
    },
  });
  if (wrong.error) throw wrong.error;
  const wrongId = (wrong.data as { id: string }).id;

  // ── 4. A matching run (the function pg_cron calls) lists it ─────────────────
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }

  // ── 5. Needs you › Check past bookings › Fix ───────────────────────────────
  await page.goto('/money/review');
  await expect(page.getByRole('heading', { name: 'Check past bookings', level: 2 })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: 'CEFT Transfer Debit' }).filter({ hasText: cardName });
  await expect(row.getByText(/probably a transfer to that card plus a \S+\s?25\.00 bank fee/)).toBeVisible();
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2, '/money/review').toBeLessThanOrEqual(0);
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect(row).toBeHidden();

  const { count: gone } = await admin.from('money_transaction').select('id', { count: 'exact', head: true }).eq('id', wrongId);
  expect(gone, 'the wrong expense is gone').toBe(0);
  const { data: linked } = await admin.from('sms_message').select('id, transaction_id').in('id', [ceft.id, payment.id]);
  const txId = linked!.find((l) => l.id === ceft.id)!.transaction_id;
  expect(txId).toBeTruthy();
  expect(linked!.find((l) => l.id === payment.id)!.transaction_id, 'both alerts point to the transfer').toBe(txId);
  const { data: tr } = await admin.from('money_transaction').select('type, account_id, to_account_id, total').eq('id', txId!).single();
  expect(tr).toMatchObject({ type: 'transfer', account_id: bank, to_account_id: card });
  expect(Number(tr!.total)).toBe(paid);
  const { data: fee } = await admin.from('money_transaction').select('type, total').eq('related_id', txId!).single();
  expect(fee!.type).toBe('expense');
  expect(Number(fee!.total)).toBe(25);
});
