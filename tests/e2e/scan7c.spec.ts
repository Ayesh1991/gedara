import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7c: "Opened" on a scan card (use-within-days rule), one-step "where is it kept" and
// "add label" scans on item pages (USB scanner into the camera sheet), and bank SMS copied from a
// screenshot by the Bill Scanner → inbox, leaving out the alert that already arrived.
// Named "E2E-7C <p|i> …"; removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-7C ${project.startsWith('phone') ? 'p' : 'i'}`;
const sheetsMade: string[] = [];
const smsBodies: string[] = [];

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  if (sheetsMade.length) await admin.from('label_sheet').delete().in('id', sheetsMade);
  if (smsBodies.length) await admin.from('sms_message').delete().in('body', smsBodies);
  const { data: assets } = await admin.from('asset').select('id').like('name', like);
  if (assets?.length) await admin.from('asset').delete().in('id', assets.map((a) => a.id));
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const productIds = (products ?? []).map((p) => p.id);
  if (productIds.length) {
    for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
      await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', productIds);
    }
  }
  await admin.from('location').delete().like('name', like);
});

function userClient() {
  const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const accessToken = (JSON.parse(item!.value) as { access_token: string }).access_token;
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function household(): Promise<string> {
  stagingAdmin(); // refuses unless this is staging
  const { data, error } = await userClient().from('household_member').select('household_id').limit(1).single();
  if (error) throw error;
  return data.household_id as string;
}

/** A USB scanner burst at scanner speed (Playwright's own key presses are too slow here). */
async function usbScan(page: Page, code: string) {
  await page.evaluate((text) => {
    for (const key of [...text, 'Enter']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }, code);
}

function colomboDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

test('Opened on a scan card starts the "use within N days" clock, with Undo', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const hh = await household();
  const db = userClient();
  const pcs = await db.from('unit').select('id').is('household_id', null).eq('code', 'pcs').single();
  const p = await db
    .from('product')
    .insert({ household_id: hh, name: `${tag} Milk`, stock_unit_id: pcs.data!.id, due_type: 'best_before', due_days_after_open: 3 })
    .select('id, code')
    .single();
  if (p.error) throw p.error;
  const buy = await db.rpc('rpc_purchase', { p: { household_id: hh, product_id: p.data.id, qty: 4, due_date: colomboDate(60) } });
  if (buy.error) throw buy.error;

  await page.goto('/scan');
  await page.getByLabel('Or type the code').fill(p.data.code);
  await page.getByRole('button', { name: 'Find' }).click();
  const card = page.getByTestId('scan-result');
  await card.getByRole('button', { name: 'Opened' }).click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'use within 3 days' });
  await expect(toast).toBeVisible();
  const opened = async () =>
    (await db.from('stock_lot').select('due_date, qty_remaining').eq('product_id', p.data.id).not('opened_at', 'is', null).gt('qty_remaining', 0)).data;
  await expect.poll(opened).toEqual([{ due_date: colomboDate(3), qty_remaining: 1 }]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await opened())?.length).toBe(0);
});

test('item pages: scan where it is kept, and add a blank label, in one step', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const hh = await household();
  const db = userClient();
  const box = (await db.from('location').insert({ household_id: hh, name: `${tag} Box`, kind: 'container' }).select('id, code, name').single()).data!;
  const bag = (await db.from('asset').insert({ household_id: hh, name: `${tag} Hand bag` }).select('id, code, name').single()).data!;
  const made = await db.rpc('rpc_label_sheets', { p_household: hh, p_format: 'sq10', p_count: 1, p_slots: 2 });
  if (made.error) throw made.error;
  const sheetId = (made.data as Array<{ id: string }>)[0]!.id;
  sheetsMade.push(sheetId);
  const codes = ((await db.from('label_tag').select('code').eq('sheet_id', sheetId).order('slot')).data ?? []).map((x) => x.code);

  // ── Kept in: wrong label first (the sheet says so and stays open), then the box ─
  await page.goto(`/things/${bag.id}`);
  await expect(page.getByTestId('asset-name')).toContainText(bag.name);
  await page.getByTestId('scan-place').click();
  await expect(page.getByTestId('scan-sheet')).toBeVisible();
  await usbScan(page, bag.code);
  await expect(page.getByTestId('scan-sheet-message')).toContainText("isn't a place label");
  await usbScan(page, box.code);
  await expect(page.getByTestId('scan-sheet')).toBeHidden();
  const where = async () => (await db.from('asset').select('location_id').eq('id', bag.id).single()).data?.location_id;
  await expect.poll(where).toBe(box.id);
  await page.locator('[data-sonner-toast]').filter({ hasText: box.name }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(where).toBeNull();

  // ── Add label: a blank one attaches at once, next to the thing's own code ─────
  await page.getByTestId('add-label').click();
  await usbScan(page, codes[0]!);
  await expect(page.getByTestId('scan-sheet')).toBeHidden();
  await expect(page.getByTestId('extra-labels')).toContainText(codes[0]!);

  // … the same label on another item is refused, with the reason in the sheet.
  await page.goto(`/places/${box.id}`);
  await expect(page.getByRole('heading', { name: box.name, level: 1 })).toBeVisible();
  await page.getByTestId('add-label').click();
  await usbScan(page, codes[0]!);
  await expect(page.getByTestId('scan-sheet-message')).toContainText(`already opens ${bag.name}`);
});

test('bank SMS from a screenshot: the one that already arrived is left out', async ({ page }) => {
  test.setTimeout(120_000);
  const hh = await household();
  const db = userClient();
  // Unique amounts so this run's alerts can't match anything else in the inbox.
  const n = Math.floor(Math.random() * 90000) + 10000;
  const money = (v: number) => v.toFixed(2);
  const ceft = `CEFT Transfer Debit Rs ${money(n + 0.25)} From A/C No XXXXXXXXXX319. Balance available Rs ${money(n * 3 + 0.5)} - Thank you for banking with BOC`;
  const atm = `ATM Withdrawal Rs ${money(n + 0.75)} From A/C No XXXXXXXXXX319. Balance available Rs ${money(n * 2 + 0.5)} - Thank you for banking with BOC`;
  smsBodies.push(ceft, atm);
  // The forwarder did deliver the CEFT alert (one minute off from the screenshot's time).
  const now = Date.now();
  const r = await db.functions.invoke('sms-ingest', {
    body: { household_id: hh, messages: [{ sender: 'BOC', body: ceft, receivedAt: now - 60 * 60_000 }] },
  });
  if (r.error) throw r.error;
  const hhmm = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

  const json = JSON.stringify({
    doc_type: 'bank_sms',
    sender: 'BOC',
    captured_on: colomboDate(),
    messages: [
      { sender: 'BOC', day_label: 'Today', time: hhmm(now - 61 * 60_000), body: ceft },
      { sender: 'BOC', day_label: 'Today', time: hhmm(now - 30 * 60_000), body: atm },
    ],
  });
  await page.goto('/money/import?tab=sms');
  await page.getByLabel('Bill Scanner JSON').fill(json);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const rows = page.getByTestId('sms-shot-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId('sms-shot-dup')).toBeVisible();
  await expect(rows.nth(1).getByTestId('sms-shot-dup')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add 1 alert to the SMS inbox' }).click();
  await expect(page.getByTestId('sms-shot-done')).toBeVisible();
  const stored = await db.from('sms_message').select('body, amount').in('body', [ceft, atm]);
  expect(stored.data?.map((s) => s.body).sort()).toEqual([atm, ceft].sort());
  await page.getByRole('link', { name: 'Open the SMS inbox' }).click();
  await expect(page).toHaveURL(/\/money\/inbox/);
});
