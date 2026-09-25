import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { billNameNorm } from '../../apps/web/src/lib/spine/normalise';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 4 "done when": a Cargills-shaped bill → expense logged, 8 lots created, 3 list items ticked,
// in one confirm. Products are found by a learned bill name, by name similarity, and one is created
// on the spot; a line is marked "not stock"; deleting the bill takes its stock back and re-opens the
// list. Then a shopping-list round trip. Everything created carries the token "e2esp<p|i>…" and is
// removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `e2esp${project.startsWith('phone') ? 'p' : 'i'}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `%${token(testInfo.project.name)}%`;
  const tx = await admin.from('money_transaction').delete().like('payee_text', like);
  if (tx.error) throw tx.error;
  const { data: products, error } = await admin.from('product').select('id').like('name', like);
  if (error) throw error;
  const ids = products.map((p) => p.id);
  if (ids.length) {
    for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
      const r = await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', ids);
      if (r.error) throw r.error;
    }
  }
  for (const [table, column] of [
    ['product_alias', 'alias_norm'],
    ['shopping_list_item', 'free_text'],
    ['account', 'name'],
    ['merchant', 'name'],
  ] as const) {
    const r = await admin.from(table).delete().like(column, like);
    if (r.error) throw r.error;
  }
});

function colomboDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/**
 * A client signed in as the e2e user (the saved session): row triggers call `private` helpers that
 * only signed-in users may use, so seed data goes in the way the app writes it.
 */
function userClient() {
  const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const token = (JSON.parse(item!.value) as { access_token: string }).access_token;
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Seeds what the household "already knows": products (one known by a bill name) and a list. */
async function seed(tag: string) {
  stagingAdmin(); // refuses unless this is staging
  const admin = userClient();
  const { data: member, error: mErr } = await admin.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id;
  const { data: units, error: unErr } = await admin.from('unit').select('id, code').is('household_id', null);
  if (unErr) throw unErr;
  const u = (code: string) => units.find((x) => x.code === code)!.id;

  const acc = await admin.from('account').insert({ household_id: household, name: `Cash ${tag}`, kind: 'cash' }).select('id').single();
  if (acc.error) throw acc.error;

  const rows = [
    { key: 'eggs', name: `Eggs ${tag}`, stock: 'pcs', purchase: 'pack', pack: 10 },
    { key: 'choc', name: `Hot chocolate ${tag}`, stock: 'pcs' },
    { key: 'sugar', name: `Sugar ${tag}`, stock: 'g', purchase: 'pack', pack: 1000 },
    { key: 'coco', name: `Coconut milk ${tag}`, stock: 'pcs' },
    { key: 'mayo', name: `Mayonnaise ${tag}`, stock: 'pcs' },
    { key: 'chilli', name: `Chilli pieces ${tag}`, stock: 'g', purchase: 'pack', pack: 100 },
    { key: 'balls', name: `Meat balls ${tag}`, stock: 'pcs' },
  ];
  const ins = await admin
    .from('product')
    .insert(rows.map((r) => ({ household_id: household, name: r.name, stock_unit_id: u(r.stock), purchase_unit_id: r.purchase ? u(r.purchase) : null })))
    .select('id, name');
  if (ins.error) throw ins.error;
  const id = (key: string) => ins.data.find((p) => p.name === rows.find((r) => r.key === key)!.name)!.id;
  const conv = await admin.from('product_unit_conversion').insert(
    rows
      .filter((r) => r.pack)
      .map((r) => ({ household_id: household, product_id: id(r.key), from_unit_id: u('pack'), to_unit_id: u(r.stock), factor: r.pack! })),
  );
  if (conv.error) throw conv.error;
  // Learned on an earlier bill: this printed name is the eggs (only the RPCs write these → service role).
  const alias = await stagingAdmin()
    .from('product_alias')
    .insert({ household_id: household, alias_norm: billNameNorm(`Havana Brown Egg ${tag}`), destiny: 'stock', product_id: id('eggs') });
  if (alias.error) throw alias.error;
  const list = await admin.from('shopping_list_item').insert([
    { household_id: household, product_id: id('eggs'), free_text: null },
    { household_id: household, product_id: id('sugar'), free_text: null },
    { household_id: household, product_id: null, free_text: `Candles ${tag}` },
  ]);
  if (list.error) throw list.error;
  return { household, id };
}

test('spine: one bill → expense + 8 lots + 3 ticks in one confirm; delete takes it back', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${token(testInfo.project.name)}${Date.now().toString(36)}`;
  const { id } = await seed(tag);
  const admin = stagingAdmin();

  const item = (name: string, category: string, subcategory: string, qty: number, price: number) => ({
    name: `${name} ${tag}`, category, subcategory, qty, unit: null, unit_price: price, amount: qty * price,
  });
  const items = [
    item('Havana Brown Egg', 'grocery', 'Eggs', 1, 570),
    item('Anchor Hot Chocolate', 'grocery', 'Beverages', 2, 130),
    item('White Sugar', 'grocery', 'Sugar', 1, 300),
    item('Sera Real Coconut Milk', 'grocery', 'Dairy & milk', 1, 210),
    item('Kist Mayonnaise Pouch', 'grocery', 'Condiments & sauces', 1, 580),
    item('Wijaya Chilli Pieces', 'grocery', 'Salt & spices', 1, 220),
    item('Prima Meat Balls', 'grocery', 'Meat', 2, 210),
    item('Prima Sunrise Shawarma', 'grocery', 'Snacks & biscuits', 1, 660),
    item('Aquafina Drinking Water', 'water', 'Bottled water', 1, 120),
    item('Bic Twin Lady Razor', 'consumable', 'Personal care', 2, 160),
  ];
  const total = items.reduce((s, i) => s + i.amount, 0);
  const bill = {
    shop: `Cargills ${tag}`, date: colomboDate(), time: '20:20', invoice_no: tag, currency: 'LKR', payment_method: 'cash',
    items, sub_total: total, discount: 0, total,
  };

  // ── Paste the scanned bill ────────────────────────────────────────────────────
  await page.goto('/money/import');
  await page.getByLabel('…or paste the JSON').fill(JSON.stringify(bill));
  const card = page.getByTestId('import-bill');
  await expect(card).toBeVisible();
  await card.getByLabel(/^Paid with/).selectOption({ label: `Cash ${tag}` });
  const rows = card.getByTestId('route-line');
  await expect(rows).toHaveCount(10);
  const row = (name: string) => rows.filter({ hasText: `${name} ${tag}` });

  // Known by its printed name (teal), bought as 1 pack = 10 eggs.
  await expect(row('Havana Brown Egg')).toContainText(`Pantry · Eggs ${tag}`);
  await expect(row('Havana Brown Egg')).toContainText('1 pack = 10 pcs');
  // Found by name (to check), converted by the pack size.
  await expect(row('White Sugar')).toContainText(`Sugar ${tag}`);
  await expect(row('White Sugar')).toContainText('1 pack = 1 kg');
  await expect(row('Aquafina Drinking Water')).toContainText('Expense only');
  await noSidewaysScroll(page, 'import review');

  // New product on the spot, counted in pieces.
  await row('Prima Sunrise Shawarma').getByRole('button', { name: 'New product' }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue(`Prima Sunrise Shawarma ${tag}`);
  await form.getByLabel('Counted in').selectOption({ label: 'pcs (piece)' });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await expect(row('Prima Sunrise Shawarma')).toContainText(`Pantry · Prima Sunrise Shawarma ${tag}`);

  // The razor isn't pantry stock; the candles on the list were bought too.
  await row('Bic Twin Lady Razor').getByRole('button', { name: 'Not stock' }).click();
  await expect(row('Bic Twin Lady Razor')).toContainText('Expense only');
  await card.getByRole('button', { name: `Candles ${tag}` }).click();
  await expect(card.getByTestId('bill-summary')).toHaveText('8 to the pantry · 3 list items ticked · 1 new product');

  // ── One confirm ───────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^Import 1 bill/ }).click();
  await expect(page).toHaveURL(/\/money\/tx\//);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: '8 added to the pantry' });
  await expect(toast).toContainText('3 ticked off the list');
  await expect(page.getByRole('link', { name: /^In the pantry:/ })).toHaveCount(8);
  await noSidewaysScroll(page, 'bill page');

  const txId = page.url().split('/money/tx/')[1]!;
  const { data: tx } = await admin.from('money_transaction').select('total, transaction_line (id)').eq('id', txId).single();
  expect(Number(tx!.total)).toBe(total);
  const lineIds = (tx!.transaction_line as Array<{ id: string }>).map((l) => l.id);
  const { data: lots } = await admin.from('stock_lot').select('product_id, qty_initial, unit_cost').in('transaction_line_id', lineIds);
  expect(lots).toHaveLength(8);
  const eggs = lots!.find((l) => l.product_id === id('eggs'))!;
  expect([Number(eggs.qty_initial), Number(eggs.unit_cost)]).toEqual([10, 57]);
  const { data: list } = await admin.from('shopping_list_item').select('done, done_by_line').in('product_id', [id('eggs'), id('sugar')]);
  expect(list!.every((i) => i.done && i.done_by_line)).toBe(true);

  // The list shows where they were bought, linking back to the bill.
  await page.goto('/pantry/list');
  const bought = page.getByTestId('shopping-done').locator('li').filter({ hasText: `Eggs ${tag}` });
  await expect(bought).toContainText(`Cargills ${tag}`);
  await noSidewaysScroll(page, '/pantry/list');

  // ── Deleting the bill takes its (untouched) stock back and re-opens the list ──
  // (In-app navigation: the delete is sent after the 8 s Undo window by this page.)
  await bought.getByRole('link', { name: new RegExp(`Cargills ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/money/tx/${txId}`));
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect
    .poll(async () => (await admin.from('money_transaction').select('id').eq('id', txId)).data?.length, { timeout: 30_000 })
    .toBe(0);
  const { data: after } = await admin.from('stock_lot').select('qty_remaining').in('product_id', [id('eggs'), id('sugar'), id('choc')]);
  expect(after!.every((l) => Number(l.qty_remaining) === 0)).toBe(true);
  const { data: reopened } = await admin.from('shopping_list_item').select('done').in('product_id', [id('eggs'), id('sugar')]);
  expect(reopened!.every((i) => !i.done)).toBe(true);
});

test('shopping list: add, tick, untick, remove', async ({ page }, testInfo) => {
  const tag = `${token(testInfo.project.name)}${Date.now().toString(36)}`;
  await page.goto('/pantry/list');
  await expect(page.getByRole('heading', { name: 'Shopping list', level: 1 })).toBeVisible();
  await page.getByPlaceholder('Add a product or anything else…').fill(`Bread ${tag}`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const open = page.getByTestId('shopping-open').locator('li').filter({ hasText: `Bread ${tag}` });
  await expect(open).toBeVisible();

  await page.getByRole('button', { name: `Bought Bread ${tag}` }).click();
  const done = page.getByTestId('shopping-done').locator('li').filter({ hasText: `Bread ${tag}` });
  await expect(done).toBeVisible();
  await page.getByRole('button', { name: `Not bought yet: Bread ${tag}` }).click();
  await expect(open).toBeVisible();

  await open.getByRole('button', { name: new RegExp(`^Bread ${tag}`) }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Remove' }).click();
  await expect(open).toHaveCount(0);
  await noSidewaysScroll(page, '/pantry/list after');
});
