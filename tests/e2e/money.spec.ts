import { expect, test, type Page } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 2 money core on staging: accounts + starting balance, a manual expense (and the "already
// saved" guard), a transfer with a bank fee, computed balances, delete + Undo, and a scanned-bill
// import that is recognised the second time. Everything created is named "E2E …<project>-…" and
// removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E ';

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${PREFIX}%${testInfo.project.name}-%`;
  const { data: accounts, error } = await admin.from('account').select('id').like('name', like);
  if (error) throw error;
  const ids = accounts.map((a) => a.id);
  if (ids.length) {
    const list = `(${ids.join(',')})`;
    const tx = await admin.from('money_transaction').delete().or(`account_id.in.${list},to_account_id.in.${list}`);
    if (tx.error) throw tx.error;
    const acc = await admin.from('account').delete().in('id', ids);
    if (acc.error) throw acc.error;
  }
  const m = await admin.from('merchant').delete().like('name', like);
  if (m.error) throw m.error;
});

function colomboDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

async function addAccount(page: Page, name: string, kind: string, limit?: string) {
  await page.goto('/money/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Type').selectOption({ label: kind });
  if (limit) await dialog.getByLabel('Credit limit (Rs)').fill(limit);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('money: accounts, expense, transfer with fee, balances, undo, bill import', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const wallet = `${PREFIX}Wallet ${tag}`;
  const card = `${PREFIX}Card ${tag}`;
  const cafe = `${PREFIX}Cafe ${tag}`;
  const shop = `${PREFIX}Shop ${tag}`;
  const today = colomboDate();

  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Money', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, '/money');

  // ── Two accounts; the wallet starts with Rs 5,000 at the end of yesterday ───
  await addAccount(page, wallet, 'Wallet');
  await addAccount(page, card, 'Credit card', '50000');
  await page.getByRole('link', { name: new RegExp(wallet) }).click();
  await expect(page.getByRole('heading', { name: wallet, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Set starting balance' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Balance', { exact: true }).fill('5000');
  await dialog.getByLabel('At the end of').fill(colomboDate(-1));
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('LKR 5,000.00').first()).toBeVisible();

  // ── A Rs 250 dining expense from the wallet, entered twice on purpose ───────
  for (const again of [false, true]) {
    await page.goto('/money?add=expense');
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Amount').fill('250');
    await dialog.getByRole('button', { name: 'Dining' }).click();
    await dialog.getByLabel('Paid with').selectOption({ label: wallet });
    await dialog.getByLabel('Time').fill('10:00');
    await dialog.getByLabel('Shop or payee').fill(cafe);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    if (again) {
      await expect(dialog.getByText(/This looks already saved/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Save another' }).click();
    }
    await expect(dialog).toBeHidden();
  }
  await expect(page.getByRole('link', { name: new RegExp(cafe) })).toHaveCount(2);

  // ── Transfer Rs 1,000 wallet → card with a Rs 25 bank fee ───────────────────
  await page.goto('/money?add=transfer');
  dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Transfer' }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByLabel('From').selectOption({ label: wallet });
  await dialog.getByLabel('To', { exact: true }).selectOption({ label: card });
  await dialog.getByLabel('Bank fee').fill('25');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Wallet: 5,000 − 250 − 250 − 1,000 − 25 = 3,475; card: nothing owed, Rs 51,000 available.
  await page.goto('/money/accounts');
  await expect(page.getByRole('link', { name: new RegExp(wallet) })).toContainText('LKR 3,475.00');
  await expect(page.getByRole('link', { name: new RegExp(card) })).toContainText('Starting balance not set yet');
  await noSidewaysScroll(page, '/money/accounts');

  // ── Delete one expense, then Undo ──────────────────────────────────────────
  await page.goto('/money');
  await page.getByRole('link', { name: new RegExp(cafe) }).first().click();
  await expect(page.getByRole('heading', { name: cafe, level: 1 })).toBeVisible();
  await noSidewaysScroll(page, 'transaction page');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.goto('/money');
  await expect(page.getByRole('link', { name: new RegExp(cafe) })).toHaveCount(2);

  // ── Import a scanned bill, then the same bill again ─────────────────────────
  const bill = JSON.stringify({
    shop,
    date: today,
    time: '09:30',
    invoice_no: tag,
    payment_method: 'card',
    items: [
      { name: 'Keeri Samba 5kg', category: 'grocery', subcategory: 'Rice', qty: 1, unit: 'pack', amount: 1450 },
      { name: 'Carrot', category: 'grocery', subcategory: 'Vegetables', qty: 0.5, unit: 'kg', unit_price: 400, amount: 200 },
    ],
    discount: 50,
    total: 1600,
  });
  await page.goto('/money/import');
  await page.getByLabel('…or paste the JSON').fill(bill);
  await expect(page.getByRole('heading', { name: shop })).toBeVisible();
  await expect(page.getByText(/one line was added for the discount/)).toBeVisible();
  await page.getByLabel(/^Paid with/).selectOption({ label: card });
  // Phase 4: grocery lines without a product don't block the import; they stay plain bill lines.
  await expect(page.getByText(/2 pantry lines have no product yet/)).toBeVisible();
  await page.getByRole('button', { name: /^Import 1 bill/ }).click();
  // One bill → its page (Phase 4).
  await expect(page).toHaveURL(/\/money\/tx\//);
  await expect(page.getByRole('heading', { name: shop })).toBeVisible();
  await expect(page.getByText('LKR 400.00 / kg')).toBeVisible(); // Rs 200 for 0.5 kg
  await expect(page.getByText('LKR 1,450.00 / pack')).toBeVisible();
  await expect(page.getByText('Bill discount / rounding')).toBeVisible();

  await page.goto('/money/import');
  await page.getByLabel('…or paste the JSON').fill(bill);
  await expect(page.getByText('Already imported')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nothing new to import' })).toBeDisabled();
  await noSidewaysScroll(page, '/money/import');
});
