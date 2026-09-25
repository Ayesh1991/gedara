import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 5 "done when": fridge, TV and laptop entered with receipts & warranty dates; an AC service
// logged as an expense. The TV comes from a bill ("bought, not entered yet"); lend/return and a sale
// with Undo; the A-number label and the /s/HL:AST:… deep link. Everything carries "E2E-THG <p|i>…"
// and is removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-THG ${project.startsWith('phone') ? 'p' : 'i'}`;
const BUCKET = 'household-files';

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  const likeAny = `%${token(testInfo.project.name)}%`;
  const { data: assets, error } = await admin.from('asset').select('id').like('name', likeAny);
  if (error) throw error;
  const ids = assets.map((a) => a.id);
  const { data: bills } = await admin.from('money_transaction').select('id').like('payee_text', likeAny);
  const txIds = (bills ?? []).map((b) => b.id);
  if (ids.length || txIds.length) {
    const { data: files } = await admin.from('attachment').select('storage_path, thumb_path').in('entity_id', [...ids, ...txIds]);
    const paths = (files ?? []).flatMap((f) => [f.storage_path, f.thumb_path]).filter((p): p is string => Boolean(p));
    if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    await admin.from('attachment').delete().in('entity_id', [...ids, ...txIds]);
  }
  if (ids.length) {
    const r = await admin.from('asset').delete().in('id', ids);
    if (r.error) throw r.error;
  }
  for (const [table, column] of [
    ['money_transaction', 'payee_text'],
    ['tag', 'name'],
    ['account', 'name'],
    ['merchant', 'name'],
  ] as const) {
    const r = await admin.from(table).delete().like(column, table === 'money_transaction' ? likeAny : like);
    if (r.error) throw r.error;
  }
});

function colomboDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/** The e2e user's own client (saved session): the app's triggers and RLS apply as in real use. */
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

/** A cash account and a bill with a TV on it (the Electronics category sends it to Things). */
async function seed(tag: string) {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id;
  const acc = await db.from('account').insert({ household_id: household, name: `Cash ${tag}`, kind: 'cash' }).select('id').single();
  if (acc.error) throw acc.error;
  const { data: cats, error: cErr } = await db.from('category').select('id, name, parent_id, key').eq('household_id', household);
  if (cErr) throw cErr;
  const top = cats.find((c) => c.key === 'nonconsumable')!;
  const electronics = cats.find((c) => c.parent_id === top.id && c.name === 'Electronics')!;
  const fp = `m${Date.now().toString(36)}${tag.slice(-1)}`;
  const bill = await db.rpc('rpc_save_transaction', {
    p: {
      household_id: household,
      type: 'expense',
      account_id: acc.data.id,
      payee_text: `Singer ${tag}`,
      occurred_on: colomboDate(-3),
      total: 150000,
      fingerprint: fp,
      lines: [{ raw_name: `Samsung TV 55 ${tag}`, category_id: electronics.id, amount: 150000, fingerprint: `${fp}-0-tv` }],
    },
  });
  if (bill.error) throw bill.error;
  return { household };
}

const PDF = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
});
// A 1×1 PNG: compressed to WebP in the browser like any photo.
const PNG = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
};

async function addThing(page: Page, name: string, price: string, warranty: string, photo = false) {
  await page.goto('/things?new=1');
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Price (Rs)').fill(price);
  await form.getByLabel('Bought on').fill(colomboDate(-30));
  await form.getByLabel('Warranty until').fill(warranty);
  if (photo) await form.getByLabel('Photo', { exact: true }).setInputFiles(PNG);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/things\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('asset-name')).toContainText(name);
  return page.url().split('/things/')[1]!;
}

async function addReceipt(page: Page, file: string) {
  await page.getByTestId('doc-input').setInputFiles(PDF(file));
  await expect(page.getByTestId('documents').getByTestId('doc').filter({ hasText: file })).toBeVisible();
}

test('things: fridge, TV and laptop with receipts & warranty; AC service logged as an expense', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const tag = `${token(testInfo.project.name)}${Date.now().toString(36)}`;
  await seed(tag);
  const admin = stagingAdmin();

  // ── The TV was on a bill: it waits under "Bought, not entered yet" ────────────
  await page.goto('/things/pending');
  const line = page.getByTestId('pending-line').filter({ hasText: `Samsung TV 55 ${tag}` });
  await expect(line).toBeVisible();
  await noSidewaysScroll(page, '/things/pending');
  await line.getByRole('button', { name: 'Add to Things' }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue(`Samsung TV 55 ${tag}`);
  await expect(form.getByLabel('Price (Rs)')).toHaveValue('150000');
  await expect(form).toContainText(`From the bill: Singer ${tag}`);
  await form.getByLabel('Warranty until').fill('2028-09-01');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/things\/[0-9a-f-]{36}$/);
  const tvId = page.url().split('/things/')[1]!;
  await expect(page.getByTestId('asset-name')).toContainText(`Samsung TV 55 ${tag}`);
  await addReceipt(page, 'tv-warranty-card.pdf');
  await noSidewaysScroll(page, 'asset page');

  const { data: tv } = await admin.from('asset').select('purchase_price, vendor, transaction_line_id, warranty_until, code, asset_no').eq('id', tvId).single();
  expect(Number(tv!.purchase_price)).toBe(150000);
  expect(tv!.vendor).toBe(`Singer ${tag}`);
  expect(tv!.transaction_line_id).not.toBeNull();
  expect(tv!.warranty_until).toBe('2028-09-01');

  // ── Fridge (with a photo) and laptop, each with a receipt ─────────────────────
  const fridgeId = await addThing(page, `Fridge ${tag}`, '185000', '2029-01-31', true);
  await addReceipt(page, 'fridge-receipt.pdf');
  const laptopId = await addThing(page, `Laptop ${tag}`, '320000', '2027-09-30');
  await addReceipt(page, 'laptop-invoice.pdf');

  const { data: docs } = await admin.from('attachment').select('entity_id, mime, title').in('entity_id', [tvId, fridgeId, laptopId]);
  expect(docs!.filter((d) => d.mime === 'application/pdf')).toHaveLength(3);
  expect(docs!.some((d) => d.entity_id === fridgeId && d.mime === 'image/webp')).toBe(true);

  // ── The AC: a 6-monthly service plan, then a service with a cost → expense ────
  const acId = await addThing(page, `AC ${tag}`, '210000', '2027-03-31');
  await page.getByRole('button', { name: 'Service plan' }).click();
  const plan = page.getByRole('dialog');
  await plan.getByLabel('What', { exact: true }).fill('AC service');
  await plan.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByTestId('plans')).toContainText('AC service');

  await page.getByTestId('plans').getByRole('button', { name: 'Log', exact: true }).click();
  const log = page.getByRole('dialog');
  await expect(log.getByLabel('What was done')).toHaveValue('AC service');
  await log.getByLabel('Cost (Rs)').fill('4500');
  await log.getByLabel('Who did it').fill(`Abans ${tag}`);
  await log.getByLabel('Paid from').selectOption({ label: `Cash ${tag}` });
  await log.getByRole('button', { name: /^Save and add/ }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'the expense is in Money' })).toBeVisible();
  await expect(page.getByTestId('logs').getByTestId('log')).toHaveCount(1);

  const { data: logs } = await admin.from('maintenance_log').select('cost, transaction_id, created_expense').eq('asset_id', acId);
  expect(logs).toHaveLength(1);
  expect([Number(logs![0]!.cost), logs![0]!.created_expense]).toEqual([4500, true]);
  const { data: expense } = await admin
    .from('money_transaction')
    .select('type, total, payee_text, transaction_line (raw_name, category_id)')
    .eq('id', logs![0]!.transaction_id!)
    .single();
  expect([expense!.type, Number(expense!.total), expense!.payee_text]).toEqual(['expense', 4500, `Abans ${tag}`]);
  const lineCat = (expense!.transaction_line as Array<{ category_id: string }>)[0]!.category_id;
  const { data: cat } = await admin.from('category').select('name').eq('id', lineCat).single();
  expect(cat!.name).toBe('Repairs & maintenance');
  const { data: due } = await admin.from('maintenance_plan').select('next_due').eq('asset_id', acId).single();
  const today = colomboDate();
  const expectedDue = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + 180)).toISOString().slice(0, 10);
  expect(due!.next_due).toBe(expectedDue);

  // The service's expense links back to it from Money.
  await page.getByTestId('logs').getByRole('link').first().click();
  await expect(page).toHaveURL(/\/money\/tx\//);
  await expect(page.getByText(`AC ${tag} — AC service`)).toBeVisible();

  // ── Lend and return, sell with Undo (laptop) ───────────────────────────────────
  await page.goto(`/things/${laptopId}`);
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Lent to').fill('Amma');
  await page.getByRole('dialog').getByRole('button', { name: 'Lend it' }).click();
  await expect(page.getByText('Lent to Amma since')).toBeVisible();
  await page.getByRole('button', { name: 'Got it back' }).click();
  await expect(page.getByText('Lent to Amma since')).toHaveCount(0);

  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  const sell = page.getByRole('dialog');
  await sell.getByLabel('Sold for (Rs)').fill('90000');
  await sell.getByLabel('Sold to').fill(`Buyer ${tag}`);
  await sell.getByLabel('Money went to').selectOption({ label: `Cash ${tag}` });
  await sell.getByRole('button', { name: 'Sell and record the income' }).click();
  await expect(page.getByRole('button', { name: 'Undo the sale' })).toBeVisible();
  const { data: sold } = await admin.from('asset').select('status, sale_transaction_id').eq('id', laptopId).single();
  expect(sold!.status).toBe('sold');
  const { data: income } = await admin.from('money_transaction').select('type, total').eq('id', sold!.sale_transaction_id!).single();
  expect([income!.type, Number(income!.total)]).toEqual(['income', 90000]);
  await page.getByRole('button', { name: 'Undo the sale' }).click();
  await expect(page.getByRole('button', { name: 'Undo the sale' })).toHaveCount(0);
  const { data: back } = await admin.from('asset').select('status, sale_transaction_id').eq('id', laptopId).single();
  expect([back!.status, back!.sale_transaction_id]).toEqual(['in_use', null]);

  // ── Gallery, the bill page link, the label and the deep link ───────────────────
  await page.goto(`/things?q=${encodeURIComponent(tag)}`);
  await expect(page.getByTestId('asset-card')).toHaveCount(4);
  await noSidewaysScroll(page, '/things');

  await page.goto(`/places/labels?assets=${tvId}&mode=niimbot`);
  await expect(page.getByText('1 label', { exact: true })).toBeVisible();

  await page.goto(`/s/${tv!.code}`);
  await expect(page).toHaveURL(new RegExp(`/things/${tvId}$`));
  await expect(page.getByTestId('documents')).toContainText('tv-warranty-card.pdf');
});
