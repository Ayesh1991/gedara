import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7f "Merge into…": a brand duplicate ("Freelan Mustard Seeds", with stock and a barcode) is
// merged into the generic product ("Mustard seeds") from its product page; the stock, the barcode and
// the old name (as a learned bill name) end up on the kept product, and the duplicate says where it
// went. Named "E2E-7F <p|i> …"; removed afterwards (staging only).
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-7F ${project.startsWith('phone') ? 'p' : 'i'}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const { data: products } = await admin.from('product').select('id').like('name', `${token(testInfo.project.name)}%`);
  const ids = (products ?? []).map((p) => p.id);
  if (!ids.length) return;
  await admin.from('product').update({ merged_into_id: null }).in('id', ids);
  for (const table of ['stock_movement', 'stock_lot', 'product_alias', 'product_barcode'] as const) {
    await admin.from(table).delete().in('product_id', ids);
  }
  await admin.from('product').delete().in('id', ids);
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

async function product(db: ReturnType<typeof userClient>, household: string, name: string, g: string, qty: number, cost: number) {
  const made = await db.from('product').insert({ household_id: household, name, stock_unit_id: g }).select('id').single();
  if (made.error) throw made.error;
  const buy = await db.rpc('rpc_purchase', {
    p: { household_id: household, product_id: made.data.id, qty, total_cost: cost },
  });
  if (buy.error) throw buy.error;
  return made.data.id as string;
}

test('a brand duplicate merges into the generic product', async ({ page }, testInfo) => {
  const tag = token(testInfo.project.name);
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const household = (await db.from('household_member').select('household_id').limit(1).single()).data!.household_id as string;
  const g = (await db.from('unit').select('id').is('household_id', null).eq('code', 'g').single()).data!.id as string;
  const keepName = `${tag} Mustard seeds`;
  const dupName = `${tag} Freelan Mustard Seeds`;
  const keep = await product(db, household, keepName, g, 200, 120);
  const dup = await product(db, household, dupName, g, 300, 150);
  const barcode = `479${Date.now().toString().slice(-10)}`;
  const bc = await db.from('product_barcode').insert({ household_id: household, product_id: dup, barcode });
  if (bc.error) throw bc.error;

  await page.goto(`/pantry/${dup}`);
  await expect(page.getByRole('heading', { name: dupName })).toBeVisible();
  await page.getByRole('button', { name: 'Merge into…' }).click();
  const pick = page.getByTestId('merge-pick');
  await pick.getByLabel('Search products').fill(keepName);
  await pick.getByRole('button', { name: new RegExp(keepName) }).click();

  const confirm = page.getByTestId('merge-confirm');
  await expect(confirm.getByText("This can't be undone.")).toBeVisible();
  await expect(confirm.getByText('Stock that moves:')).toBeVisible();
  if (testInfo.project.name.startsWith('phone')) {
    await page.screenshot({ path: testInfo.outputPath('merge-confirm-375.png') });
  }
  await confirm.getByRole('button', { name: `Merge into ${keepName}` }).click();

  await expect(page).toHaveURL(new RegExp(`/pantry/${keep}$`));
  await expect(page.getByRole('heading', { name: keepName })).toBeVisible();

  const stock = await db.from('v_product_stock').select('qty').eq('product_id', keep).single();
  expect(Number(stock.data!.qty)).toBe(500);
  const merged = await db.from('product').select('archived, merged_into_id').eq('id', dup).single();
  expect(merged.data).toEqual({ archived: true, merged_into_id: keep });
  expect((await db.from('product_barcode').select('product_id').eq('barcode', barcode).single()).data!.product_id).toBe(keep);
  const alias = await db.from('product_alias').select('product_id').eq('household_id', household).eq('alias_norm', dupName.toLowerCase().replace(/-/g, ' ')).single();
  expect(alias.data!.product_id).toBe(keep);

  await page.goto(`/pantry/${dup}`);
  const banner = page.getByTestId('merged-into');
  await expect(banner).toContainText(`merged into ${keepName}`);
  await expect(page.getByRole('button', { name: 'Merge into…' })).toHaveCount(0);
  await banner.getByRole('link', { name: `Open ${keepName}` }).click();
  await expect(page).toHaveURL(new RegExp(`/pantry/${keep}$`));
});
