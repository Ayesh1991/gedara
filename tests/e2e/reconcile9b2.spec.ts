import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.2 fix on staging, the prod mistakes found when the balances didn't match:
//   * a Sampath card payment booked as a transfer from "Savings" with no debit behind it, while a BOC CEFT
//     debit (+ Rs 25 fee) from the other account waits → "Booked from …, but this … debit paid it" → Fix
//     moves it to that account and books the fee;
//   * the same card-payment alert again (a backup's copy two days later, same balance) booked as a second
//     transfer → "sent this alert twice" → Fix removes that entry and marks the copy seen;
//   * money moved from ··708 to Savings: the inbox offers one transfer; booked instead as spending on one
//     side and income on the other → "one transfer between your own accounts" → Fix makes it one.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-RC ';
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

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const lkr = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });

test('a card payment moved to the account that paid it; a copied alert removed', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const phone = testInfo.project.name.startsWith('phone');
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;

  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  const pick = (lo: number, span: number) => { let d = ''; while (!d || used.has(d)) d = String(lo + Math.floor(Math.random() * span)); used.add(d); return d; };
  const dSav = pick(100, 900);
  const d708 = pick(100, 900);
  const dCard = pick(1000, 9000);
  const savings = `${PREFIX}Savings ${tag}`;
  const current = `${PREFIX}Current ${tag}`;
  const cardName = `${PREFIX}Sampath ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: household, name: savings, kind: 'bank', institution: 'BOC', last4: dSav, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: current, kind: 'bank', institution: 'BOC', last4: d708, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: cardName, kind: 'credit_card', institution: 'Sampath', last4: dCard, credit_limit: 300000, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
  ]).select('id, name');
  if (acc.error) throw acc.error;
  const id = (n: string) => acc.data.find((a) => a.name === n)!.id;
  runs.set(testInfo.project.name, [...(runs.get(testInfo.project.name) ?? []), ...acc.data.map((a) => a.id)]);

  const paid = (phone ? 41000 : 43000) + Math.floor(Math.random() * 900);
  const now = Date.now();
  const day = new Date(now - 6 * 3600e3 + 5.5 * 3600e3);
  const ddMon = `${String(day.getUTCDate()).padStart(2, '0')}-${MONTHS[day.getUTCMonth()]}`;
  const cardText = `Cr Crd no..**${dCard} Credited LKR ${lkr(paid)} for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 129,517.96 Enq Call 0112300604 - Sampath Bank ${ddMon}`;
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="3">
${sms('SAMPCCTXN', now - 50 * 3600e3, cardText)}
${sms('BOC', now - 50 * 3600e3 - 120_000, `CEFT Transfer Debit Rs ${paid + 25}.00 From A/C No XXXXXXXXXX${d708}. Balance available Rs 40000.00 - Thank you for banking with BOC`)}
${sms('SAMPCCTXN', now - 2 * 3600e3, cardText)}
</smses>`;

  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 3 bank alerts to the inbox' }).click();
  await expect(page.getByText(/3 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // ── The past mistakes: both card alerts booked as transfers from Savings ───
  const db = userClient();
  const { data: cards, error: cErr } = await admin.from('sms_message').select('id, occurred_on, received_at').eq('account_id', id(cardName)).order('received_at');
  if (cErr) throw cErr;
  expect(cards).toHaveLength(2);
  for (const c of cards) {
    const r = await db.rpc('rpc_sms_post', {
      p_sms_ids: [c.id],
      p: { household_id: household, type: 'transfer', account_id: id(savings), to_account_id: id(cardName), occurred_on: c.occurred_on, total: paid, lines: [] },
    });
    if (r.error) throw r.error;
  }

  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }

  await page.goto('/money/review');
  await expect(page.getByRole('heading', { name: 'Check past bookings', level: 2 })).toBeVisible();
  const dup = page.getByRole('listitem').filter({ hasText: 'sent this' }).filter({ hasText: cardName });
  await expect(dup.getByText(/SAMPCCTXN sent this .* alert twice/)).toBeVisible();
  const move = page.getByRole('listitem').filter({ hasText: `Booked from ${savings}` });
  await expect(move.getByText(`debit from ${current} paid the`, { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/review').toBeLessThanOrEqual(0);

  await dup.getByRole('button', { name: 'Fix' }).click();
  await expect(dup).toBeHidden();
  await move.getByRole('button', { name: 'Fix' }).click();
  await expect(move).toBeHidden();

  // ── One transfer, from the account that paid it, with its fee; the copy is seen ──
  const { data: trs, error: tErr } = await admin.from('money_transaction').select('id, account_id, total').eq('type', 'transfer').eq('to_account_id', id(cardName));
  if (tErr) throw tErr;
  expect(trs).toHaveLength(1);
  expect(trs[0]!.account_id).toBe(id(current));
  expect(Number(trs[0]!.total)).toBe(paid);
  const { data: fee } = await admin.from('money_transaction').select('total').eq('related_id', trs[0]!.id).single();
  expect(Number(fee!.total)).toBe(25);
  const { data: copy } = await admin.from('sms_message').select('ignored, transaction_id').eq('id', cards[1]!.id).single();
  expect(copy).toMatchObject({ ignored: true, transaction_id: null });
});

test('money moved between your own accounts is one transfer', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const phone = testInfo.project.name.startsWith('phone');
  const tag = `${testInfo.project.name}-own-${Date.now().toString(36)}`;
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  const pick = () => { let d = ''; while (!d || used.has(d)) d = String(100 + Math.floor(Math.random() * 900)); used.add(d); return d; };
  const dSav = pick();
  const d708 = pick();
  const savings = `${PREFIX}Own savings ${tag}`;
  const current = `${PREFIX}Own current ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: household, name: savings, kind: 'bank', institution: 'BOC', last4: dSav, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
    { household_id: household, name: current, kind: 'bank', institution: 'BOC', last4: d708, credit_limit: null, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
  ]).select('id, name');
  if (acc.error) throw acc.error;
  const id = (n: string) => acc.data.find((a) => a.name === n)!.id;
  runs.set(testInfo.project.name, [...(runs.get(testInfo.project.name) ?? []), ...acc.data.map((a) => a.id)]);

  const moved = (phone ? 101000 : 111000) + Math.floor(Math.random() * 900) * 10;
  const now = Date.now();
  const sms = (date: number, body: string) => `<sms protocol="0" address="BOC" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="2">
${sms(now - 3 * 3600e3, `Online Transfer Debit Rs ${moved}.00 From A/C No XXXXXXXXXX${d708}. Balance available Rs 300000.00 - Thank you for banking with BOC`)}
${sms(now - 3 * 3600e3 + 60_000, `Online Transfer Credit Rs ${moved}.00 To A/C No XXXXXXXXXX${dSav}. Balance available Rs ${moved + 1000}.00 - Thank you for banking with BOC`)}
</smses>`;
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 2 bank alerts to the inbox' }).click();
  await expect(page.getByText(/2 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // ── The inbox offers one transfer ────────────────────────────────────────────
  await page.goto('/money/inbox');
  await expect(page.getByText(`Transfer ${current} → ${savings}`).first()).toBeVisible();

  // ── Booked instead as spending + income (as on prod) → Check past bookings ───
  const db = userClient();
  const { data: alerts } = await admin.from('sms_message').select('id, kind, occurred_on, fingerprint').in('account_id', [id(savings), id(current)]);
  const { data: cats } = await admin.from('category').select('id, key, parent_id').eq('household_id', household).is('parent_id', null);
  const other = cats!.find((c) => c.key === 'other')!.id;
  const income = cats!.find((c) => c.key === 'income')!.id;
  for (const a of alerts!) {
    const debit = a.kind === 'bank_debit';
    const r = await db.rpc('rpc_sms_post', {
      p_sms_ids: [a.id],
      p: {
        household_id: household, type: debit ? 'expense' : 'income', account_id: debit ? id(current) : id(savings), occurred_on: a.occurred_on, total: moved,
        lines: [{ raw_name: debit ? 'Online Transfer Debit' : 'Online Transfer Credit', category_id: debit ? other : income, amount: moved, fingerprint: `${a.fingerprint}-0-x` }],
      },
    });
    if (r.error) throw r.error;
  }
  for (let attempt = 0; ; attempt++) {
    const r = await db.functions.invoke('match-agent', { body: { household_id: household, mode: 'run' } });
    if (!r.error) break;
    const status = (r.error as { context?: Response }).context?.status;
    if (status !== 429 || attempt > 3) throw r.error;
    await page.waitForTimeout(62_000);
  }
  await page.goto('/money/review');
  const row = page.getByRole('listitem').filter({ hasText: `left ${current} and arrived in ${savings}` });
  await expect(row.getByText('one transfer between your own accounts', { exact: false })).toBeVisible();
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect(row).toBeHidden();

  const { data: txs } = await admin.from('money_transaction').select('type, account_id, to_account_id, total').or(`account_id.in.(${id(savings)},${id(current)}),to_account_id.in.(${id(savings)},${id(current)})`);
  expect(txs).toEqual([expect.objectContaining({ type: 'transfer', account_id: id(current), to_account_id: id(savings) })]);
  expect(Number(txs![0]!.total)).toBe(moved);
});
