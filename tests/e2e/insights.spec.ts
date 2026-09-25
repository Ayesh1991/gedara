import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { GREETING, STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 6 "done when": every number is clickable down to the record — Home's Spent tile →
// category → sub-category → item → the bill line on its bill. Plus: a budget moves the Home ring
// and shows in Attention; a recurring bill due → Attention → Pay → gone → Undo brings it back; a
// lot expiring tomorrow is in Attention; ⌘K finds a bill line. Everything carries "E2E-INS <p|i>"
// (own top-level category, so budgets never touch real ones) and is removed afterwards.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-INS ${project.startsWith('phone') ? 'p' : 'i'}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  for (const [table, column] of [
    ['money_transaction', 'payee_text'],
    ['recurring_rule', 'name'],
  ] as const) {
    const r = await admin.from(table).delete().like(column, like);
    if (r.error) throw r.error;
  }
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const ids = (products ?? []).map((p) => p.id);
  if (ids.length) {
    for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
      const r = await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', ids);
      if (r.error) throw r.error;
    }
  }
  // Sub-categories first, then the top level (budgets go with them).
  for (const parentNull of [false, true]) {
    const q = admin.from('category').delete().like('name', like);
    const r = await (parentNull ? q.is('parent_id', null) : q.not('parent_id', 'is', null));
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

/** Own category (top + sub), an account, a bill line in it and a yoghurt that expires tomorrow. */
async function seed(tag: string) {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id;
  const top = await db.from('category').insert({ household_id: household, name: `${tag} Food`, kind: 'expense' }).select('id').single();
  if (top.error) throw top.error;
  const sub = await db
    .from('category')
    .insert({ household_id: household, parent_id: top.data.id, name: `${tag} Rice`, kind: 'expense' })
    .select('id')
    .single();
  if (sub.error) throw sub.error;
  const { data: account, error: aErr } = await db.from('account').select('id').eq('household_id', household).eq('archived', false).eq('is_suspense', false).limit(1).single();
  if (aErr) throw aErr;
  const fp = `m${Date.now().toString(36)}${tag.slice(-1)}`;
  const bill = await db.rpc('rpc_save_transaction', {
    p: {
      household_id: household,
      type: 'expense',
      account_id: account.id,
      payee_text: `${tag} Keells`,
      occurred_on: colomboDate(0),
      total: 1500,
      fingerprint: fp,
      lines: [{ line_no: 0, raw_name: `${tag} keeri samba 5kg`, category_id: sub.data.id, amount: 1500, fingerprint: `${fp}-0-a` }],
    },
  });
  if (bill.error) throw bill.error;
  const { data: pcs } = await db.from('unit').select('id').is('household_id', null).eq('code', 'pcs').single();
  const product = await db
    .from('product')
    .insert({ household_id: household, name: `${tag} Yoghurt`, stock_unit_id: pcs!.id, due_type: 'expiry' })
    .select('id')
    .single();
  if (product.error) throw product.error;
  const buy = await db.rpc('rpc_purchase', {
    p: { household_id: household, product_id: product.data.id, qty: 1, total_cost: 120, due_date: colomboDate(1) },
  });
  if (buy.error) throw buy.error;
  return { household, topId: top.data.id, subId: sub.data.id, accountId: account.id };
}

test('insights: Home → category → sub → item → bill line; budget; recurring bill; expiring lot; ⌘K', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = token(testInfo.project.name);
  const phone = testInfo.project.name.startsWith('phone');
  await seed(tag);
  const month = colomboDate(0).slice(0, 7);

  // ── Every number is a link: Home Spent → Spending → category → sub → item → the line ──
  await page.goto('/');
  await page.getByText('Spent this month').click();
  await expect(page).toHaveURL(new RegExp(`/insights/spend\\?from=${month}`));
  await expect(page.getByRole('heading', { name: 'Spending', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, 'spend domain');
  await page.getByRole('link', { name: new RegExp(`^${tag} Food`) }).click();
  await expect(page).toHaveURL(/cat=/);
  await page.getByRole('link', { name: new RegExp(`^${tag} Rice`) }).click();
  await expect(page).toHaveURL(/sub=/);
  await page.getByRole('link', { name: new RegExp(`^${tag} keeri samba 5kg`) }).click();
  await expect(page).toHaveURL(/name=/);
  await expect(page.getByRole('heading', { name: '1 bill line' })).toBeVisible();
  // The breadcrumb walks back up.
  await expect(page.getByRole('navigation', { name: 'Where you are' }).getByRole('link', { name: `${tag} Rice` })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`${tag} keeri samba 5kg`) }).click();
  await expect(page).toHaveURL(/\/money\/tx\/[0-9a-f-]+\?line=/);
  await expect(page.locator('li[aria-current="true"]')).toContainText(`${tag} keeri samba 5kg`);

  // ── Budget: set it in Money › Budgets; Home shows it, Attention says it's over ──
  await page.goto(`/money/budgets?month=${month}`);
  const input = page.getByLabel(`Budget for ${tag} Food`);
  await input.fill('1000');
  await input.press('Enter');
  await expect(page.getByText(/Saved from/)).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(`${tag} Food`) }).first()).toBeVisible();
  await expect(page.getByText(`${tag} Food is over budget`)).toBeVisible();

  // ── A lot expiring tomorrow is in Attention ──
  await page.goto('/attention');
  await expect(page.getByText(`${tag} Yoghurt is due tomorrow`)).toBeVisible();
  await noSidewaysScroll(page, 'attention');

  // ── Recurring bill: add → overdue in Attention → Pay → gone → Undo → back ──
  await page.goto('/money/recurring?add=1');
  const form = page.getByRole('dialog');
  await form.getByLabel('Name').fill(`${tag} Water`);
  await form.getByLabel('Category').selectOption({ label: `${tag} Rice` });
  await form.getByLabel('Usual amount').fill('500');
  await form.getByLabel('First due date').fill(colomboDate(-2));
  await form.getByRole('button', { name: 'Add recurring bill' }).click();
  await expect(form).toBeHidden();
  await page.goto('/attention');
  const bill = page.getByRole('link', { name: new RegExp(`${tag} Water is overdue`) });
  await expect(bill).toBeVisible();
  await bill.click();
  const pay = page.getByRole('dialog');
  await expect(pay.getByRole('heading', { name: `Pay ${tag} Water` })).toBeVisible();
  await pay.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText(new RegExp(`${tag} Water paid for`))).toBeVisible();
  await page.goto('/attention');
  await expect(page.getByText(new RegExp(`${tag} Food`)).first()).toBeVisible(); // the page loaded
  await expect(page.getByRole('link', { name: new RegExp(`${tag} Water is overdue`) })).toHaveCount(0);
  // Undo = delete the payment: the bill is due again.
  await page.goto('/money/recurring');
  const card = page.getByRole('listitem').filter({ hasText: `${tag} Water` });
  await card.getByRole('link', { name: /Last paid/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  // The delete commits after its 8 s Undo window.
  await page.waitForTimeout(9_500);
  await page.goto('/attention');
  await expect(page.getByRole('link', { name: new RegExp(`${tag} Water is overdue`) })).toBeVisible({ timeout: 20_000 });

  // ── ⌘K finds a bill line and opens its bill ──
  await page.goto('/');
  await expect(page.getByRole('heading', { name: GREETING })).toBeVisible();
  if (phone) await page.getByRole('button', { name: 'Search', exact: true }).click();
  else await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('combobox').fill(`${tag} keeri`);
  await expect(palette.getByRole('option', { name: new RegExp(`${tag} keeri samba 5kg`) })).toBeVisible();
  await palette.getByRole('combobox').press('Enter');
  await expect(page).toHaveURL(/\/money\/tx\/[0-9a-f-]+\?line=/);

  // ── The other areas open without errors and without sideways scrolling ──
  for (const area of ['cashflow', 'prices', 'pantry', 'things', 'utilities', 'places']) {
    await page.goto(`/insights/${area}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText("Couldn't load this view.")).toHaveCount(0);
    await noSidewaysScroll(page, area);
  }
  await page.goto('/insights');
  await expect(page.getByText('Tap any number to see the records behind it.')).toBeVisible();
  await noSidewaysScroll(page, 'insights');
});
