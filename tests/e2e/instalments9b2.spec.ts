import { expect, test } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 9b.2 on staging, Money › Instalments: a card plan entered from a statement line ("Toyota Lanka
// <7/12> 6,470.72") and a loan (Rs 2,000,000 at 12 % for 60 months = Rs 44,488.90) through the form;
// each card shows where it stands, the loan its interest / principal split; a plan can be deleted.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-IP ';
const runs = new Map<string, string[]>();

test.afterAll(async ({}, testInfo) => {
  const ids = runs.get(testInfo.project.name);
  if (!ids) return;
  const admin = stagingAdmin();
  const plans = await admin.from('instalment_plan').delete().in('account_id', ids);
  if (plans.error) throw plans.error;
  const acc = await admin.from('account').delete().in('id', ids);
  if (acc.error) throw acc.error;
});

test('instalment plans: a card plan and a loan at a glance', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const admin = stagingAdmin();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const card = `${PREFIX}Card ${tag}`;
  const loan = `${PREFIX}Loan ${tag}`;
  const acc = await admin.from('account').insert([
    { household_id: hh.id, name: card, kind: 'credit_card', institution: 'BOC', last4: null, credit_limit: 250000, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
    { household_id: hh.id, name: loan, kind: 'loan', institution: 'BOC', last4: null, credit_limit: 2000000, opening_balance: 0, opening_on: '2026-01-01', is_suspense: false },
  ]).select('id, name');
  if (acc.error) throw acc.error;
  runs.set(testInfo.project.name, acc.data.map((a) => a.id));
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const plan = `Toyota ${tag}`;

  await page.goto('/money');
  await page.getByRole('link', { name: 'Instalments' }).click();
  await expect(page.getByRole('heading', { name: 'Instalments', level: 1 })).toBeVisible();

  // ── A card plan, from a statement line: instalment 7 of 12 fell today ───────
  await page.getByRole('button', { name: 'Add plan' }).click();
  await page.locator('#plan-account').selectOption({ label: card });
  await page.getByLabel('Name').fill(plan);
  await page.getByLabel('Each month (Rs)').fill('6470.72');
  await page.getByLabel('How many months').fill('12');
  await page.getByLabel('Latest instalment number').fill('7');
  await page.getByLabel('Its date').fill(today);
  await page.getByRole('button', { name: 'Save plan' }).click();
  const cardRow = page.getByRole('listitem').filter({ hasText: plan }).filter({ has: page.getByRole('meter') });
  await expect(cardRow.getByText('7 of 12')).toBeVisible();
  await expect(cardRow.getByText(/32,353\.60 left/)).toBeVisible();

  // ── A loan: the bank's instalment checks out; the split of the next one ─────
  await page.getByRole('button', { name: 'Add plan' }).click();
  await page.getByRole('tab', { name: 'Loan' }).click();
  await page.locator('#plan-account').selectOption({ label: loan });
  await page.getByLabel('Name').fill(`BOC loan ${tag}`);
  await page.getByLabel('Each month (Rs)').fill('44488.90');
  await page.getByLabel('How many months').fill('60');
  await page.getByLabel('Latest instalment number').fill('1');
  await page.getByLabel('Its date').fill(today);
  await page.getByLabel('Amount borrowed (Rs)').fill('2000000');
  await page.getByLabel('Yearly interest (%)').fill('12');
  await expect(page.getByText(/the bank's instalment would be .*44,488\.90/)).toBeVisible();
  await page.getByRole('button', { name: 'Save plan' }).click();
  const loanRow = page.getByRole('listitem').filter({ hasText: `BOC loan ${tag}` }).filter({ has: page.getByRole('meter') });
  await expect(loanRow.getByText('1 of 60')).toBeVisible();
  await expect(loanRow.getByText(/Still owed: .*1,975,511\.10/)).toBeVisible();
  await expect(loanRow.getByText(/19,755\.11 interest \+ .*24,733\.79 repays the loan/)).toBeVisible();

  await expect(page.getByRole('heading', { name: 'When the monthly total drops' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '/money/instalments').toBeLessThanOrEqual(0);

  // ── Delete the card plan ─────────────────────────────────────────────────────
  await cardRow.getByRole('button', { name: 'Edit plan' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(cardRow).toBeHidden();
  const { count } = await admin.from('instalment_plan').select('id', { count: 'exact', head: true }).in('account_id', acc.data.map((a) => a.id));
  expect(count).toBe(1);
});
