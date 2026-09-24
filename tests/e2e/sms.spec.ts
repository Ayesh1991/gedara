import { expect, test, type Page } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 2b bank-SMS import on staging:
//   SMS-backup XML (synthetic, real wording) → inbox → link a card alert to a scanned bill waiting in
//   "to be matched" (it moves to the card) → BOC debit + card payment saved as one transfer with its
//   Rs 25 fee → "Bank says" = "Gedara says" → undo a link → add a phone in Settings and post an alert
//   to sms-ingest with its token (device path) → ignore it.
// Test accounts use random card digits so alerts never resolve to the real seeded accounts; amounts
// differ per project so the phone and iPad runs (parallel) can't pair each other's alerts.
test.use({ storageState: STORAGE_STATE });

// Not 'E2E ': money.spec's cleanup deletes accounts named 'E2E …<project>-…' and may run in parallel.
const PREFIX = 'E2E-SMS ';

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${PREFIX}%${testInfo.project.name}-%`;
  const { data: accounts, error } = await admin.from('account').select('id').like('name', like);
  if (error) throw error;
  const ids = accounts.map((a) => a.id);
  const { data: devices } = await admin.from('sms_device').select('id').like('name', like);
  const deviceIds = (devices ?? []).map((d) => d.id);
  if (ids.length) {
    const list = `(${ids.join(',')})`;
    const s = await admin.from('sms_message').delete().in('account_id', ids);
    if (s.error) throw s.error;
    const tx = await admin.from('money_transaction').delete().or(`account_id.in.${list},to_account_id.in.${list}`);
    if (tx.error) throw tx.error;
    const acc = await admin.from('account').delete().in('id', ids);
    if (acc.error) throw acc.error;
  }
  if (deviceIds.length) {
    await admin.from('sms_message').delete().in('device_id', deviceIds);
    await admin.from('sms_device').delete().in('id', deviceIds);
  }
  await admin.from('merchant').delete().like('name', like);
});

const pad = (n: number) => String(n).padStart(2, '0');

/** Colombo wall clock of an instant: { day: 'YYYY-MM-DD', dmy: 'dd/mm/yyyy', time12: '01:09:29 PM' }. */
function colombo(ms: number) {
  const d = new Date(ms + 5.5 * 3600e3);
  const h = d.getUTCHours();
  return {
    day: d.toISOString().slice(0, 10),
    dmy: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    time12: `${pad(h % 12 || 12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`,
  };
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

test('bank SMS: backup import, link, transfer + fee, bank balance check, phone forwarding', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const admin = stagingAdmin();
  const project = testInfo.project.name;
  const tag = `${project}-${Date.now().toString(36)}`;
  const TAG = tag.toUpperCase();
  const bocName = `${PREFIX}BOC ${tag}`;
  const cardName = `${PREFIX}Seylan ${tag}`;
  const matchName = `${PREFIX}Match ${tag}`;

  // Random digits that no other account uses.
  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d3 = '';
  let d4 = '';
  while (!d3 || used.has(d3)) d3 = String(100 + Math.floor(Math.random() * 900));
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));

  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const twoDaysAgo = colombo(Date.now() - 2 * 86_400_000).day;
  const { data: accs, error: accErr } = await admin
    .from('account')
    .insert([
      { household_id: hh.id, name: bocName, kind: 'bank', institution: 'BOC', last4: d3, opening_balance: 100000, opening_on: twoDaysAgo, is_suspense: false },
      { household_id: hh.id, name: cardName, kind: 'credit_card', institution: 'Seylan', last4: d4, credit_limit: 100000, opening_balance: -30000, opening_on: twoDaysAgo, is_suspense: false },
      { household_id: hh.id, name: matchName, kind: 'credit_card', is_suspense: true, opening_balance: 0 },
    ])
    .select('id, name');
  if (accErr) throw accErr;
  const matchId = accs.find((a) => a.name === matchName)!.id;

  // Amounts unique to this project run (phone and iPad run in parallel).
  const base = (project.startsWith('phone') ? 21000 : 26000) + Math.floor(Math.random() * 900);
  const charge = 1000 + Math.floor(Math.random() * 900) + 0.56;
  const now = Date.now();
  const tPay = now - 3 * 3600e3;
  const tDebit = tPay + 40_000;
  const tCharge = now - 3600e3;
  const payC = colombo(tPay);
  const chargeC = colombo(tCharge);

  // A scanned bill for the card charge, waiting in "to be matched".
  const fp = `be2e${Date.now().toString(36)}${project.length}`;
  const { data: bill, error: billErr } = await admin
    .from('money_transaction')
    .insert({ household_id: hh.id, type: 'expense', account_id: matchId, payee_text: `${PREFIX}Shop ${tag}`, occurred_on: chargeC.day, total: charge, source: 'scan', fingerprint: fp })
    .select('id')
    .single();
  if (billErr) throw billErr;
  const line = await admin.from('transaction_line').insert({ household_id: hh.id, transaction_id: bill.id, line_no: 0, raw_name: 'Groceries', amount: charge, fingerprint: `${fp}-0-x` });
  if (line.error) throw line.error;

  // ── 1. Import an SMS Backup & Restore file ────────────────────────────────────
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="5">
${sms('Seylan Bank', tPay, `Seylan Credit Card Services - Thank you for your payment of LKR ${money(base)} made to Card # ...${d4} on ${payC.dmy} ${payC.time12}. Avl bal ${money(70000 + base)}`)}
${sms('BOC', tDebit, `CEFT Transfer Debit Rs ${(base + 25).toFixed(2)} From A/C No XXXXXXXXXX${d3}. Balance available Rs ${(100000 - base - 25).toFixed(2)} - Thank you for banking with BOC`)}
${sms('Seylan Bank', tCharge, `Seylan Card ...${d4} debit Txn ${Date.now()} of LKR ${money(charge)} done on ${chargeC.dmy} ${chargeC.time12} at E2E SHOP ${TAG} COLOMBO LK. Avl bal ${money(70000 + base - charge)}`)}
${sms('BOC', now - 60_000, 'Your OTP for the online transfer is 482913. Do not share it with anyone.')}
${sms('+94770000000', now, 'Personal message that must never leave the device')}
</smses>`;

  await page.goto('/money/import?tab=sms');
  await expect(page.getByRole('tab', { name: 'Bank SMS' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await expect(page.getByText('Left out: 1 other conversations, 1 OTPs, 0 promotions, 0 sent by you.')).toBeVisible();
  await page.getByRole('button', { name: 'Send 3 bank alerts to the inbox' }).click();
  await expect(page.getByText(/3 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // Importing the same file again stores nothing new.
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: 'Send 3 bank alerts to the inbox' }).click();
  await expect(page.getByText(/0 new alerts in the inbox, 3 were already there\./)).toBeVisible();

  // ── 2. Review: link the card alert to the waiting bill ──────────────────────
  await page.goto('/money/inbox');
  await expect(page.getByRole('heading', { name: 'Bank alerts', level: 1 })).toBeVisible();
  const chargeCard = page.getByRole('listitem').filter({ hasText: `E2E SHOP ${TAG}` });
  await expect(chargeCard.getByText(`Matches ${PREFIX}Shop ${tag}`, { exact: false })).toBeVisible();
  await expect(chargeCard.getByText(`It moves from "to be matched" to ${cardName}.`)).toBeVisible();
  await noSidewaysScroll(page, '/money/inbox');
  await chargeCard.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Linked', { exact: true }).first()).toBeVisible();
  await expect(chargeCard).toBeHidden();

  // ── 3. BOC debit + Seylan payment → one transfer with the Rs 25 fee ─────────
  const pair = page.getByRole('listitem').filter({ hasText: `Transfer ${bocName} → ${cardName}` });
  await expect(pair.getByText('plus Rs 25.00 bank fee')).toBeVisible();
  await pair.getByRole('button', { name: 'Save transfer' }).click();
  await expect(pair).toBeHidden();

  // ── 4. Balances agree with what the banks said ──────────────────────────────
  await page.goto('/money/accounts');
  await page.getByRole('link', { name: new RegExp(bocName) }).click();
  await expect(page.getByRole('heading', { name: bocName, level: 1 })).toBeVisible();
  const bocSays = page.getByText(/Bank said on/);
  await expect(bocSays).toContainText(`LKR ${money(100000 - base - 25)}`);
  await expect(bocSays).not.toContainText('Gedara:');

  await page.goto('/money/accounts');
  await page.getByRole('link', { name: new RegExp(cardName) }).click();
  await expect(page.getByRole('heading', { name: cardName, level: 1 })).toBeVisible();
  await expect(page.getByText(`${PREFIX}Shop ${tag}`)).toBeVisible(); // the bill moved here
  const cardSays = page.getByText(/Available credit the bank said on/);
  await expect(cardSays).toContainText(`LKR ${money(70000 + base - charge)}`);
  await expect(cardSays).not.toContainText('Gedara:');

  // ── 5. Undo a link from Reviewed; the alert is back to review ───────────────
  await page.goto('/money/inbox?view=reviewed');
  const done = page.getByRole('listitem').filter({ hasText: `E2E SHOP ${TAG}` });
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(done).toBeHidden();
  await page.goto('/money/inbox');
  await expect(page.getByRole('listitem').filter({ hasText: `E2E SHOP ${TAG}` })).toBeVisible();

  // ── 6. Add a phone; its token posts straight to sms-ingest ──────────────────
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'SMS forwarding', level: 1 })).toBeVisible();
  await page.getByLabel('Phone name').fill(`${PREFIX}Phone ${tag}`);
  await page.getByRole('button', { name: 'Add phone' }).click();
  await expect(page.getByText('The secret below is shown only now.', { exact: false })).toBeVisible();
  await noSidewaysScroll(page, '/settings/devices');
  const headers = JSON.parse(
    (await page.locator('code').filter({ hasText: 'X-Gedara-Device' }).textContent()) ?? '{}',
  ) as Record<string, string>;
  const url = (await page.locator('code').filter({ hasText: '/functions/v1/sms-ingest' }).textContent()) ?? '';
  expect(url).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/sms-ingest$/);

  const forwarded = await request.post(url, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    data: {
      from: 'Seylan Bank',
      text: `Seylan Card ...${d4} debit Txn ${Date.now() + 1} of LKR 77.00 done on ${colombo(now).dmy} ${colombo(now).time12} at E2E PHONE ${TAG} LK. Avl bal 1.00`,
      receivedStamp: now,
    },
  });
  expect(forwarded.status()).toBe(200);
  expect(await forwarded.json()).toMatchObject({ ok: true, stored: 1 });
  const otp = await request.post(url, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    data: { from: 'BOC', text: 'Your OTP is 123456. Do not share it.', receivedStamp: now },
  });
  expect(await otp.json()).toMatchObject({ ok: true, stored: 0, filtered: 'otp' });
  const wrong = await request.post(url, {
    headers: { 'X-Gedara-Device': 'A'.repeat(43), 'Content-Type': 'application/json' },
    data: { from: 'BOC', text: 'x Rs 1', receivedStamp: now },
  });
  expect(wrong.status()).toBe(401);

  await page.getByRole('button', { name: "I've copied everything" }).click();
  const phoneRow = page.getByRole('listitem').filter({ hasText: `${PREFIX}Phone ${tag}` });
  await expect(phoneRow.getByText(/1 alerts · 1 filtered out/)).toBeVisible();

  // The forwarded alert is in the inbox; ignore it.
  await page.goto('/money/inbox');
  const phoneCard = page.getByRole('listitem').filter({ hasText: `E2E PHONE ${TAG}` });
  await expect(phoneCard).toBeVisible();
  await phoneCard.getByRole('button', { name: 'Ignore' }).click();
  await expect(phoneCard).toBeHidden();

  // Removing the phone stops its token at once.
  await page.goto('/settings/devices');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('listitem').filter({ hasText: `${PREFIX}Phone ${tag}` }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(`Removed ${PREFIX}Phone ${tag}`)).toBeVisible();
  const revoked = await request.post(url, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    data: { from: 'BOC', text: 'x Rs 1', receivedStamp: now },
  });
  expect(revoked.status()).toBe(401);
});
