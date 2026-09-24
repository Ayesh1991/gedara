import { expect, test, type Page } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 3 "done when": a product with a pack size, two lots with different due dates, one use that
// takes from both in FEFO order, Undo restoring both, the journal, the overview and a scan of the
// product's label. Products are named "E2E-PAN …<project>-…" and removed afterwards with the staging
// service-role client (journal rows first: stock history otherwise keeps a product alive).
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-PAN ';

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const { data: products, error } = await admin
    .from('product')
    .select('id')
    .like('name', `${PREFIX}%${testInfo.project.name}-%`);
  if (error) throw error;
  const ids = products.map((p) => p.id);
  if (!ids.length) return;
  for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
    const r = await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', ids);
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

async function addStock(page: Page, qty: string, unit: string, price: string, due: string) {
  await page.getByRole('button', { name: 'Add stock' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity').fill(qty);
  await dialog.getByLabel('Unit', { exact: true }).selectOption({ label: unit });
  await dialog.getByLabel('Price paid (Rs, optional)').fill(price);
  await dialog.getByLabel('Best before').fill(due);
  await dialog.getByRole('button', { name: 'Add stock' }).click();
  await expect(dialog).toBeHidden();
}

test('pantry: product, two lots, FEFO use across both, undo, journal, scan', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const name = `${PREFIX}Sugar ${tag}`;

  // ── New product: counted in g, bought in packs of 400 g ──────────────────────
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, '/pantry');
  await page.getByRole('button', { name: /^(New product|Add your first product)$/ }).first().click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Counted in').selectOption({ label: 'g (gram)' });
  await form.getByLabel('days after buying').fill('180');
  await form.getByText('More details').click();
  await form.getByLabel('Bought as').selectOption({ label: 'pack' });
  await form.getByLabel('1 pack = how many g').fill('400');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('1 pack = 400 g')).toBeVisible();
  await noSidewaysScroll(page, 'product page');

  // ── Two lots: 2 packs due later, 1 kg due sooner ─────────────────────────────
  await addStock(page, '2', 'pack', '440', colomboDate(200));
  await addStock(page, '1', 'kg (kilogram)', '300', colomboDate(60));
  const lots = page.getByTestId('lot');
  await expect(lots).toHaveCount(2);
  // FEFO order on screen: the one due sooner first.
  await expect(lots.nth(0)).toContainText('1 kg');
  await expect(lots.nth(1)).toContainText('800 g');
  await expect(page.getByText(/550\.00 \/ kg/).first()).toBeVisible();

  // ── Use 1.2 kg: all of the 1 kg lot, then 200 g of the packs ─────────────────
  await page.getByRole('button', { name: 'Use', exact: true }).first().click();
  const use = page.getByRole('dialog');
  await use.getByLabel('Quantity').fill('1.2');
  await use.getByLabel('Unit', { exact: true }).selectOption({ label: 'kg (kilogram)' });
  await use.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(use).toBeHidden();
  const usedToast = page.locator('[data-sonner-toast]').filter({ hasText: `Used 1.2 kg of ${name}` });
  await expect(usedToast).toBeVisible();
  await expect(lots).toHaveCount(1);
  await expect(lots.nth(0)).toContainText('600 g');

  // ── Undo puts both lots back ─────────────────────────────────────────────────
  await usedToast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Undone' })).toBeVisible();
  await expect(lots).toHaveCount(2);
  await expect(lots.nth(0)).toContainText('1 kg');
  await expect(lots.nth(1)).toContainText('800 g');

  // ── Journal: the use is there, marked undone ─────────────────────────────────
  await page.goto('/pantry/journal');
  await expect(page.getByRole('heading', { name: 'Stock journal', level: 1 })).toBeVisible();
  const entry = page.getByTestId('journal').locator('li').filter({ hasText: name }).filter({ hasText: 'undone' });
  await expect(entry.first()).toBeVisible();
  await noSidewaysScroll(page, '/pantry/journal');

  // ── Overview: 1.8 kg in stock ────────────────────────────────────────────────
  await page.goto(`/pantry?q=${encodeURIComponent(tag)}`);
  const card = page.getByTestId('product-card').filter({ hasText: name });
  await expect(card).toContainText('1.8 kg');

  // ── Scan the product's label code ────────────────────────────────────────────
  await card.getByRole('link', { name }).click();
  const code = (await page.getByText(/^HL:PRD:[0-9A-HJKMNP-TV-Z]{6}$/).first().textContent())!.trim();
  await page.goto('/scan');
  await page.getByLabel('Or type the code').fill(code);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByTestId('scan-result').filter({ hasText: name })).toBeVisible();
  await noSidewaysScroll(page, '/scan');
});
