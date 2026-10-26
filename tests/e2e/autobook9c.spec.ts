import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9c on staging: two BOC debits + the Sampath card payments they paid wait in the inbox; transfers
// are switched on (the record seeded as proven) → "Check now" books both by itself → What changed lists
// them → Undo puts one back in Bank alerts (its entry gone), Looks right marks the other. The switch
// belongs to the whole household, so only the phone run books (the iPad run checks the pages' layout).
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-9C ';
const runs = new Map<string, { accounts: string[]; household: string; before: { auto: unknown; auto_record: unknown } | null }>();

test.afterAll(async ({}, testInfo) => {
  const run = runs.get(testInfo.project.name);
  if (!run) return;
  const admin = stagingAdmin();
  if (run.before) {
    const r = await admin.from('match_setting').update({ auto: run.before.auto, auto_record: run.before.auto_record } as never)
      .eq('household_id', run.household);
    if (r.error) throw r.error;
  }
  const ids = run.accounts;
  const { data: alerts } = await admin.from('sms_message').select('id').in('account_id', ids);
  const smsIds = (alerts ?? []).map((a) => a.id);
  if (smsIds.length) {
    for (const q of [admin.from('match_suggestion').delete().in('sms_id', smsIds), admin.from('match_autobook').delete().overlaps('sms_ids', smsIds)]) {
      const r = await q;
      if (r.error) throw r.error;
    }
  }
  const accts = ids.join(',');
  for (const q of [
    admin.from('sms_message').delete().in('account_id', ids),
    admin.from('money_transaction').delete().not('related_id', 'is', null).or(`account_id.in.(${accts}),to_account_id.in.(${accts})`),
    admin.from('money_transaction').delete().or(`account_id.in.(${accts}),to_account_id.in.(${accts})`),
    admin.from('account').delete().in('id', ids),
  ]) {
    const r = await q;
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const lkr = (n: number) => new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR' }).format(n);

test('9c: transfers booked by themselves, then undone or marked right', async ({ page }, testInfo) => {
  const phone = testInfo.project.name.startsWith('phone');
  if (!phone) {
    // layout only: the pages fit an iPad
    for (const path of ['/money/changes', '/settings/matching']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    return;
  }
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d3 = '';
  let d4 = '';
  while (!d3 || used.has(d3)) d3 = String(100 + Math.floor(Math.random() * 900));
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));
  const acc = await admin.from('account').insert([
    { household_id: household, name: `${PREFIX}BOC ${tag}`, kind: 'bank', institution: 'BOC', last4: d3, credit_limit: null, opening_balance: 100000, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: `${PREFIX}Card ${tag}`, kind: 'credit_card', institution: 'Sampath', last4: d4, credit_limit: 300000, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
  ]).select('id, kind');
  if (acc.error) throw acc.error;
  const bank = acc.data.find((a) => a.kind === 'bank')!.id;
  const card = acc.data.find((a) => a.kind === 'credit_card')!.id;
  const { data: setting } = await admin.from('match_setting').select('auto, auto_record').eq('household_id', household).maybeSingle();
  runs.set(testInfo.project.name, { accounts: [bank, card], household, before: setting ?? null });

  // two BOC debits + the Sampath card payments they paid, a few hours old, imported from an SMS backup
  const a1 = 21000 + Math.floor(Math.random() * 400) * 10;
  const a2 = a1 + 1370;
  const now = Date.now();
  const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });
  const dayMon = (t: number) => new Date(t + 5.5 * 3600e3).toUTCString().slice(5, 11).replace(' ', '-').toUpperCase();
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const debit = (t: number, amount: number, balance: number) => sms('BOC', t,
    `CEFT Transfer Debit Rs ${amount}.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs ${balance}.00 - Thank you for banking with BOC`);
  const payment = (t: number, amount: number) => sms('SAMPCCTXN', t,
    `Cr Crd no..**${d4} Credited LKR ${money(amount)} for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 129,517.96 Enq Call 0112300604 - Sampath Bank ${dayMon(t)}`);
  const t1 = now - 5 * 3600e3;
  const t2 = now - 4 * 3600e3;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="4">
${debit(t1, a1 + 25, 90000)}
${payment(t1 + 120e3, a1)}
${debit(t2, a2 + 25, 60000)}
${payment(t2 + 120e3, a2)}
</smses>`;
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 4 bank alerts to the inbox' }).click();
  await expect(page.getByText(/4 new alerts in the inbox, 0 were already there\./)).toBeVisible();
  const { data: imported, error: impErr } = await admin.from('sms_message').select('id, amount, account_id').in('account_id', [bank, card]);
  if (impErr) throw impErr;
  expect(imported, 'each alert found its account').toHaveLength(4);
  const ins = { data: imported };

  // ── Transfers switched on (their record seeded as proven on staging) ───────
  const seeded = await admin.from('match_setting').update({ auto: ['alert_transfer'], auto_record: { alert_transfer: { right: 25, of: 25 } } } as never)
    .eq('household_id', household);
  if (seeded.error) throw seeded.error;
  await page.goto('/settings/matching');
  const transfers = page.getByRole('listitem').filter({ hasText: 'Transfers between your accounts' });
  await expect(transfers.getByText('On: books by itself', { exact: false })).toBeVisible();
  await expect(transfers.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

  // ── Check now: the run books them by itself ─────────────────────────────────
  const db = userClient();
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }
  const { data: linked } = await admin.from('sms_message').select('id, transaction_id').in('account_id', [bank, card]);
  expect(linked!.every((s) => s.transaction_id), 'all four alerts booked').toBe(true);

  await page.goto('/money/changes');
  await expect(page.getByRole('heading', { name: 'What changed', level: 1 })).toBeVisible();
  const first = page.getByRole('listitem').filter({ hasText: lkr(a1) });
  const second = page.getByRole('listitem').filter({ hasText: lkr(a2) });
  await expect(first.getByText('Transfers between your accounts', { exact: false })).toBeVisible();
  await expect(second.getByText('Transfers between your accounts', { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/changes').toBeLessThanOrEqual(0);

  // ── Undo one: both alerts wait again, the transfer is gone ──────────────────
  await first.getByRole('button', { name: 'Undo' }).click();
  await expect(first.getByText('Undone', { exact: true })).toBeVisible();
  const ids1 = ins.data.filter((s) => Number(s.amount) === a1 || Number(s.amount) === a1 + 25).map((s) => s.id);
  const { data: back } = await admin.from('sms_message').select('transaction_id').in('id', ids1);
  expect(back!.every((s) => s.transaction_id === null)).toBe(true);
  const { count } = await admin.from('money_transaction').select('id', { count: 'exact', head: true })
    .eq('account_id', bank).eq('to_account_id', card).eq('total', a1);
  expect(count).toBe(0);

  // ── Looks right on the other ────────────────────────────────────────────────
  // (with nothing left to look at, the run folds away under "Earlier")
  await second.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.getByText('Marked as looked at')).toBeVisible();
  const ids2 = ins.data.filter((s) => Number(s.amount) === a2).map((s) => s.id);
  await expect.poll(async () => {
    const { data } = await admin.from('match_autobook').select('reviewed_at, undone_at').overlaps('sms_ids', ids2);
    return data?.length === 1 && !!data[0]!.reviewed_at && !data[0]!.undone_at;
  }).toBe(true);

  await page.goto('/money/inbox');
  // the undone pair waits again as one transfer card
  const waiting = page.getByRole('listitem').filter({ hasText: lkr(a1) });
  await expect(waiting.getByRole('button', { name: 'Save transfer' })).toBeVisible();
});
