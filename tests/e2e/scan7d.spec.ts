import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7d: a blank label becomes a Cupboard; a place type of your own ("+ New type") in the place
// form, shown on the place and renamed in Settings › Place types; "+ New category…" from a thing's
// category picker. Named "E2E-7D <p|i> …"; removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-7D ${project.startsWith('phone') ? 'p' : 'i'}`;
const sheetsMade: string[] = [];

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  if (sheetsMade.length) await admin.from('label_sheet').delete().in('id', sheetsMade);
  await admin.from('asset').delete().like('name', like);
  await admin.from('location').delete().like('name', like);
  await admin.from('place_type').delete().like('name', like);
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

async function household(): Promise<string> {
  stagingAdmin(); // refuses unless this is staging
  const { data, error } = await userClient().from('household_member').select('household_id').limit(1).single();
  if (error) throw error;
  return data.household_id as string;
}

test('a blank label becomes a cupboard', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const hh = await household();
  const db = userClient();
  const made = await db.rpc('rpc_label_sheets', { p_household: hh, p_format: 'sq10', p_count: 1, p_slots: 1 });
  if (made.error) throw made.error;
  const sheetId = (made.data as Array<{ id: string }>)[0]!.id;
  sheetsMade.push(sheetId);
  const code = (await db.from('label_tag').select('code').eq('sheet_id', sheetId).single()).data!.code as string;

  await page.goto(`/s/${code}`);
  await page.getByTestId('claim-panel').getByRole('button', { name: 'New Cupboard' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} Hall cupboard`);
  await expect(form.getByRole('button', { name: 'Cupboard', pressed: true })).toBeVisible();
  await form.getByRole('button', { name: 'Add place' }).click();
  await expect(page.getByTestId('claimed')).toContainText(`${tag} Hall cupboard`);
  const row = await db.from('location').select('kind').eq('name', `${tag} Hall cupboard`).single();
  expect(row.data?.kind).toBe('cupboard');
});

test('a place type of your own, then renamed in Settings', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const db = userClient();

  await page.goto('/places');
  await page.getByRole('button', { name: /^(Add place|Add your first place)$/ }).first().click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} Garage wall`);
  await form.getByRole('button', { name: 'New type' }).click();
  const sheet = page.getByTestId('place-type-sheet');
  await sheet.getByLabel('Name', { exact: true }).fill(`${tag} Tool wall`);
  await sheet.getByRole('button', { name: 'wrench' }).click();
  await sheet.getByRole('button', { name: 'Save type' }).click();
  await expect(sheet).toBeHidden();
  await expect(form.getByRole('button', { name: `${tag} Tool wall`, pressed: true })).toBeVisible();
  await form.getByRole('button', { name: 'Add place' }).click();
  await expect(form).toBeHidden();

  const type = (await db.from('place_type').select('id, icon').eq('name', `${tag} Tool wall`).single()).data!;
  expect(type.icon).toBe('wrench');
  const place = (await db.from('location').select('id, type_id, kind').eq('name', `${tag} Garage wall`).single()).data!;
  expect(place).toMatchObject({ type_id: type.id, kind: null });
  await page.goto(`/places/${place.id}`);
  await expect(page.getByText(`${tag} Tool wall`).first()).toBeVisible();

  await page.goto('/settings/place-types');
  await page.getByRole('button', { name: `Edit ${tag} Tool wall` }).click();
  await page.getByTestId('place-type-sheet').getByLabel('Name', { exact: true }).fill(`${tag} Pegboard`);
  await page.getByTestId('place-type-sheet').getByRole('button', { name: 'Save type' }).click();
  await expect(page.getByTestId('own-place-types')).toContainText(`${tag} Pegboard`);
  expect((await db.from('place_type').select('name').eq('id', type.id).single()).data?.name).toBe(`${tag} Pegboard`);
});

test('closing a sheet on top of a form leaves the form open (camera scan into the barcode field)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/pantry?new=1');
  const form = page.getByRole('dialog');
  await form.getByText('More details').click();
  await form.getByRole('button', { name: 'Scan with the camera' }).click();
  await expect(page.getByTestId('scan-sheet')).toBeVisible();
  // The USB scanner while the camera sheet is open: same as a camera read.
  await page.evaluate((text) => {
    for (const key of [...text, 'Enter']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }, '4792024000222');
  await expect(page.getByTestId('scan-sheet')).toBeHidden();
  await expect(form.getByLabel('Barcode', { exact: true })).toHaveValue('4792024000222');
  await expect(form.getByLabel('Name', { exact: true })).toBeVisible();
});

test('"+ New category…" from a thing\'s category picker is added and picked', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const db = userClient();

  await page.goto('/things?new=1');
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} Hand bag`);
  await form.getByLabel('Category').selectOption('__new__');
  const sheet = page.getByTestId('new-category-sheet');
  await sheet.getByLabel('Name', { exact: true }).fill(`${tag} Bags`);
  await sheet.getByRole('button', { name: 'Add and pick it' }).click();
  await expect(sheet).toBeHidden();
  const cat = (await db.from('category').select('id').eq('name', `${tag} Bags`).single()).data!;
  await expect(form.getByLabel('Category')).toHaveValue(cat.id);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/things\/[0-9a-f-]{36}$/);
  const thing = (await db.from('asset').select('category_id').eq('name', `${tag} Hand bag`).single()).data!;
  expect(thing.category_id).toBe(cat.id);
});
