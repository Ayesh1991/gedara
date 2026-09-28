import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7e "Books are Things": a book entered as a Pantry product (ISBN + blank QR label, like
// Didula's) moves to Things with both; Fill a rack with an ISBN and a QR label back to back; copies
// sharing an ISBN ask which one; an unknown ISBN → New thing keeps it; the product form's Things
// category → "Save as a thing instead". Named "E2E-7E <p|i> …"; removed afterwards (staging only).
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-7E ${project.startsWith('phone') ? 'p' : 'i'}`;
const sheetsMade: string[] = [];

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  if (sheetsMade.length) await admin.from('label_sheet').delete().in('id', sheetsMade);
  await admin.from('asset').delete().like('name', like);
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const ids = (products ?? []).map((p) => p.id);
  if (ids.length) {
    for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
      await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', ids);
    }
  }
  await admin.from('location').delete().like('name', like);
  await admin.from('category').delete().like('name', like);
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

/** A valid ISBN-13 (EAN) nobody has. */
function isbn(): string {
  const body = `978${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`;
  const sum = [...body].reverse().reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel('Or type the code').fill(code);
  await page.getByRole('button', { name: 'Find' }).click();
}

interface Seed {
  household: string;
  books: { id: string; name: string };
}

/** A "Books" sub-category under Non-consumables (it becomes a Things category by itself). */
async function seed(tag: string): Promise<Seed> {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member } = await db.from('household_member').select('household_id').limit(1).single();
  const household = member!.household_id as string;
  const top = (await db.from('category').select('id').eq('household_id', household).eq('key', 'nonconsumable').single()).data!;
  const cat = await db.from('category').insert({ household_id: household, parent_id: top.id, name: `${tag} Books`, kind: 'expense' }).select('id, default_destiny').single();
  if (cat.error) throw cat.error;
  expect(cat.data.default_destiny).toBe('asset');
  return { household, books: { id: cat.data.id, name: `${tag} Books` } };
}

async function blankCodes(household: string, n: number): Promise<string[]> {
  const db = userClient();
  const made = await db.rpc('rpc_label_sheets', { p_household: household, p_format: 'sq10', p_count: 1, p_slots: n });
  if (made.error) throw made.error;
  const sheetId = (made.data as Array<{ id: string }>)[0]!.id;
  sheetsMade.push(sheetId);
  return ((await db.from('label_tag').select('code').eq('sheet_id', sheetId).order('slot')).data ?? []).map((x) => x.code as string);
}

test('a book entered in Pantry moves to Things with its ISBN and QR label, then fills a rack', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();
  const pcs = (await db.from('unit').select('id').is('household_id', null).eq('code', 'pcs').single()).data!;
  const code = isbn();
  const p = (await db
    .from('product')
    .insert({ household_id: s.household, name: `${tag} Rosemaryta book`, category_id: s.books.id, stock_unit_id: pcs.id, due_type: 'none' })
    .select('id')
    .single()).data!;
  await db.from('product_barcode').insert({ household_id: s.household, product_id: p.id, barcode: code });
  const [label, label2] = await blankCodes(s.household, 2);
  await db.rpc('rpc_tag_assign', { p_code: label, p_kind: 'product', p_id: p.id });
  const rack = (await db.from('location').insert({ household_id: s.household, name: `${tag} Rack 1`, kind: 'rack' }).select('id').single()).data!;
  // A second book already a Thing, known by its QR label only.
  const other = (await db.from('asset').insert({ household_id: s.household, name: `${tag} Saara book` }).select('id').single()).data!;
  await db.rpc('rpc_tag_assign', { p_code: label2, p_kind: 'asset', p_id: other.id });

  // ── Pantry: "Move to Things" (only this test's book ticked) ──────────────────
  await page.goto('/pantry');
  await expect(page.getByTestId('to-things-banner')).toBeVisible();
  await page.getByTestId('to-things-banner').getByRole('button', { name: 'Move to Things' }).click();
  const sheet = page.getByRole('dialog');
  for (const box of await sheet.getByRole('checkbox').all()) {
    const label = (await box.locator('xpath=..').textContent()) ?? '';
    if (!label.includes(tag) && (await box.isChecked())) await box.uncheck();
  }
  await sheet.getByRole('button', { name: /^Move 1 to Things$/ }).click();
  await expect(page.getByTestId('to-things-done')).toContainText('1 moved');
  const thing = (await db.from('asset').select('id').eq('name', `${tag} Rosemaryta book`).single()).data!;
  expect((await db.from('asset_barcode').select('barcode').eq('asset_id', thing.id)).data?.map((b) => b.barcode)).toEqual([code]);
  expect((await db.from('label_tag').select('asset_id').eq('code', label).single()).data?.asset_id).toBe(thing.id);
  expect((await db.from('product').select('id').eq('id', p.id)).data).toHaveLength(0);

  // ── Rack 1 → Fill: the ISBN, then the other book's QR label, back to back ────
  await page.goto(`/places/${rack.id}`);
  await page.getByRole('button', { name: 'Fill' }).click();
  await typeCode(page, code);
  await typeCode(page, label2!);
  await expect(page.getByTestId('fill-row')).toHaveCount(2);
  await expect
    .poll(async () => (await db.from('asset').select('location_id').in('id', [thing.id, other.id])).data?.map((a) => a.location_id))
    .toEqual([rack.id, rack.id]);
});

test('copies sharing an ISBN ask which one; an unknown ISBN becomes a new thing with it', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();
  const shared = isbn();
  for (const n of [1, 2]) {
    const a = (await db.from('asset').insert({ household_id: s.household, name: `${tag} Copy ${n}` }).select('id').single()).data!;
    await db.from('asset_barcode').insert({ household_id: s.household, asset_id: a.id, barcode: shared });
  }
  await page.goto('/scan');
  await typeCode(page, shared);
  const card = page.getByTestId('scan-result');
  await expect(card).toContainText('2 copies have this barcode');
  await expect(card.getByRole('link')).toHaveCount(2);

  const fresh = isbn();
  await typeCode(page, fresh);
  await page.getByTestId('scan-result').getByRole('link', { name: 'New thing' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} New novel`);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/things\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('asset-barcodes')).toContainText(fresh);
});

test('the product form sends a Things category to "Save as a thing instead"', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();
  await page.goto('/pantry?new=1');
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} Bisnas book`);
  await form.getByLabel('Category').selectOption(s.books.id);
  await expect(form.getByTestId('thing-category-hint')).toBeVisible();
  await form.getByRole('button', { name: 'Save as a thing instead' }).click();
  const thingForm = page.getByRole('dialog', { name: 'New thing', exact: true });
  await expect(thingForm.getByLabel('Name', { exact: true })).toHaveValue(`${tag} Bisnas book`);
  await thingForm.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await db.from('asset').select('category_id').eq('name', `${tag} Bisnas book`)).data).toEqual([{ category_id: s.books.id }]);
  expect((await db.from('product').select('id').eq('name', `${tag} Bisnas book`)).data).toHaveLength(0);
});
