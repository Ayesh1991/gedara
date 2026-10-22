import { expect, test } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9a on staging: an SMS backup with a Sinhala OTP (left out), a debit from an account Gedara
// doesn't know (→ "New account seen" → one tap adds it and the alert points to it), a Seylan charge and
// its reversal (→ refund that found its purchase), and a People's instalment plan (→ a note: "Mark as
// seen"). Names carry their own prefix; random digits keep the phone and iPad runs apart.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-9A ';
const runs = new Map<string, { tag: string; d3: string }>();

test.afterAll(async ({}, testInfo) => {
  const run = runs.get(testInfo.project.name);
  if (!run) return;
  const admin = stagingAdmin();
  const { data: accounts, error } = await admin
    .from('account')
    .select('id')
    .or(`name.like.${PREFIX}%${testInfo.project.name}-%,and(last4.eq.${run.d3},name.like.BOC ··%)`);
  if (error) throw error;
  const ids = accounts.map((a) => a.id);
  const tagged = await admin.from('sms_message').delete().like('body', `%${run.tag}%`);
  if (tagged.error) throw tagged.error;
  const digits = await admin.from('sms_message').delete().eq('last_digits', run.d3);
  if (digits.error) throw digits.error;
  if (ids.length) {
    const s = await admin.from('sms_message').delete().in('account_id', ids);
    if (s.error) throw s.error;
    const acc = await admin.from('account').delete().in('id', ids);
    if (acc.error) throw acc.error;
  }
});

const pad = (n: number) => String(n).padStart(2, '0');
function colombo(ms: number) {
  const d = new Date(ms + 5.5 * 3600e3);
  const h = d.getUTCHours();
  return {
    day: d.toISOString().slice(0, 10),
    dmy: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    time12: `${pad(h % 12 || 12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`,
  };
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

test('9a: OTPs left out, new account seen, refund, instalment note', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const admin = stagingAdmin();
  const project = testInfo.project.name;
  const tag = `${project}-${Date.now().toString(36)}`;
  // Letters only in alert text: a 4–8-digit number an alert doesn't explain is dropped as a possible OTP.
  const TAG = `${project.startsWith('phone') ? 'PHONE' : 'IPAD'}${Date.now().toString(36).toUpperCase().replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]!)}`;
  const seylanName = `${PREFIX}Seylan ${tag}`;

  const { data: taken } = await admin.from('account').select('last4');
  const used = new Set((taken ?? []).map((a) => a.last4));
  let d3 = '';
  let d4 = '';
  while (!d3 || used.has(d3)) d3 = String(100 + Math.floor(Math.random() * 900));
  while (!d4 || used.has(d4)) d4 = String(1000 + Math.floor(Math.random() * 9000));
  runs.set(project, { tag: TAG, d3 });

  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const acc = await admin.from('account').insert({
    household_id: hh.id, name: seylanName, kind: 'credit_card', institution: 'Seylan', last4: d4, credit_limit: 100000,
    opening_balance: 0, opening_on: colombo(Date.now() - 2 * 86_400_000).day, is_suspense: false,
  });
  if (acc.error) throw acc.error;

  const now = Date.now();
  const debitAmt = (project.startsWith('phone') ? 3100 : 3600) + Math.floor(Math.random() * 400);
  const txnId = String(10_000_000_000 + Math.floor(Math.random() * 1e9));
  const tCharge = now - 3 * 3600e3;
  const tRev = now - 2 * 3600e3;
  const c = colombo(tCharge);
  const r = colombo(tRev);
  const sms = (address: string, date: number, body: string) =>
    `<sms protocol="0" address="${address}" date="${date}" type="1" body="${esc(body)}" read="1" />`;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="6">
${sms('BOC', now - 4 * 3600e3, `Online Transfer Debit Rs ${debitAmt}.00 From A/C No XXXXXXXXXX${d3}. Balance available Rs 50000.00 - Thank you for banking with BOC`)}
${sms('Seylan Bank', tCharge, `Seylan Card ...${d4} debit Txn ${txnId} of USD 6.15 done on ${c.dmy} ${c.time12} at E2E STORE ${TAG} IE. Avl bal 90,000.00`)}
${sms('Seylan Bank', tRev, `Transaction Reversal (${txnId}): Seylan Card ...${d4} was credited USD 6.15 on ${r.dmy} ${r.time12} at E2E STORE ${TAG} IE. Avl bal 91,900.00`)}
${sms('PeoplesCard', now - 3600e3, `Dear Card Holder, 12-months instalment plan for LKR 123,456.00/= transaction at E2E PLAN ${TAG} successfully created. Hotline 1961.`)}
${sms('BOC', now - 60_000, 'ඔබගේ එක් වරක් භාවිත මුරපදය 482913 වේ. කිසිවෙකු සමඟ බෙදා නොගන්න.')}
${sms('BOC', now - 30_000, 'OTP482913 for BOC Smart Pay')}
</smses>`;

  // ── 1. Import: both OTPs (Sinhala, and glued to the word) are left out ───────
  await page.goto('/money/import?tab=sms');
  await page.locator('input[type=file]').setInputFiles({ name: 'sms-backup.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await expect(page.getByText('Left out: 0 other conversations, 2 OTPs, 0 promotions, 0 sent by you.')).toBeVisible();
  await page.getByRole('button', { name: 'Send 4 bank alerts to the inbox' }).click();
  await expect(page.getByText(/4 new alerts in the inbox, 0 were already there\./)).toBeVisible();

  // ── 2. New account seen → one tap adds it; its alert points to it ───────────
  await page.goto('/money/inbox');
  await expect(page.getByRole('heading', { name: 'Bank alerts', level: 1 })).toBeVisible();
  const seen = page.getByRole('listitem').filter({ hasText: `New account seen: BOC ··${d3}` });
  await expect(seen.getByText('Bank account · 1 alert waiting')).toBeVisible();
  await seen.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText(`BOC ··${d3} added: its alerts now point to it`)).toBeVisible();
  await expect(seen).toBeHidden();
  await expect(page.getByRole('listitem').filter({ hasText: `BOC ··${d3}` }).filter({ hasText: 'Bank debit' }).first()).toBeVisible();

  // ── 3. The reversal is a refund that found its purchase ─────────────────────
  const refund = page.getByRole('listitem').filter({ hasText: 'Money back on the card.' }).filter({ hasText: `E2E STORE ${TAG}` });
  await expect(refund.getByText('It undoes a purchase in these alerts', { exact: false })).toBeVisible();
  await expect(refund.getByRole('button', { name: 'Save refund' })).toBeVisible();

  // ── 4. The instalment plan is a note: no new spending ───────────────────────
  const note = page.getByRole('listitem').filter({ hasText: `E2E PLAN ${TAG}` });
  await expect(note.getByText('An instalment plan for a purchase already counted', { exact: false })).toBeVisible();
  await note.getByRole('button', { name: 'Mark as seen' }).click();
  await expect(note).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/inbox').toBeLessThanOrEqual(0);
});
