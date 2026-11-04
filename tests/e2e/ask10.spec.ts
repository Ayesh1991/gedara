import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { GREETING, STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 10 on staging — Ask Gedara. The owner finds Ask off on Home, switches it on in Settings › Ask Gedara,
// asks on Home (→ /ask) where a thing with a hostile name ("<img …> https://evil…") is shown as plain text with
// links only to Gedara's own pages, marks it valuable (Ask then never shows it), gets an OTP-looking question
// refused before anything is sent, and asks again from Ctrl+K. The switch belongs to the household, so only the
// phone run asks (the iPad run checks the pages' layout). Real AI calls (Groq → OpenAI): ~3 questions a run.
test.use({ storageState: STORAGE_STATE });

const TOKEN = 'e2easkp';
const HOSTILE = `${TOKEN} lamp <img src=x onerror=alert(1)> https://evil.example`;
const runs = new Map<string, { household: string; before: { ask_enabled: boolean; ask_daily_per_person: number } | null }>();

test.afterAll(async ({}, testInfo) => {
  const run = runs.get(testInfo.project.name);
  if (!run) return;
  const admin = stagingAdmin();
  const { data: things } = await admin.from('asset').select('id').like('name', `${TOKEN}%`);
  const ids = (things ?? []).map((a) => a.id);
  if (ids.length) {
    const r = await admin.from('asset').delete().in('id', ids);
    if (r.error) throw r.error;
  }
  if (run.before) {
    const r = await admin.from('match_setting').update(run.before as never).eq('household_id', run.household);
    if (r.error) throw r.error;
  }
});

function userClient() {
  const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const access = (JSON.parse(item!.value) as { access_token: string }).access_token;
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${access}` } },
  });
}

async function noOverflow(page: Page, path: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, path).toBeLessThanOrEqual(0);
}

/** Every answer: plain text only — no image, no element from the data, every link inside Gedara. */
async function answerIsSafe(page: Page) {
  const answers = page.getByRole('region', { name: 'Answer' });
  await expect(answers.first()).toBeVisible({ timeout: 60_000 });
  expect(await page.locator('section[aria-label="Answer"] img').count()).toBe(0);
  const hrefs = await page.locator('section[aria-label="Answer"] a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  for (const h of hrefs) expect(h.startsWith('/'), h).toBe(true);
  await expect(page.getByText(/^Understood by (Groq|OpenAI) · /)).toBeVisible();
}

test('10: Ask Gedara — switch on, ask, plain-text answers, valuables hidden, unsafe question refused', async ({ page }, testInfo) => {
  const phone = testInfo.project.name.startsWith('phone');
  if (!phone) {
    for (const path of ['/settings/ask', '/ask']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: 'Ask Gedara' })).toBeVisible();
      await noOverflow(page, path);
    }
    return;
  }
  test.setTimeout(300_000);
  const admin = stagingAdmin();
  const { data: hh, error: hhErr } = await admin.from('household').select('id').eq('name', 'Gedara').single();
  if (hhErr) throw hhErr;
  const household = hh.id;
  const { data: before } = await admin.from('match_setting').select('ask_enabled, ask_daily_per_person').eq('household_id', household).maybeSingle();
  runs.set(testInfo.project.name, { household, before: before ?? null });
  const off = await admin.from('match_setting').upsert({ household_id: household, ask_enabled: false, ask_daily_per_person: 100 } as never);
  if (off.error) throw off.error;

  const db = userClient();
  const thing = await db.from('asset').insert({ household_id: household, name: HOSTILE }).select('id').single();
  if (thing.error) throw thing.error;

  // Off: Home shows the owner where to switch it on
  await page.goto('/');
  await expect(page.getByRole('heading', { name: GREETING })).toBeVisible();
  await page.getByText('Ask Gedara is off. Turn it on in Settings › Ask Gedara.').click();
  await expect(page).toHaveURL(/\/settings\/ask$/);
  await noOverflow(page, '/settings/ask');
  await page.getByRole('switch', { name: 'Ask Gedara' }).click();
  await expect(page.getByRole('switch', { name: 'Ask Gedara' })).toHaveAttribute('aria-checked', 'true');

  // Ask on Home → /ask; the hostile name stays text, links stay inside Gedara
  await page.goto('/');
  await expect(page.getByRole('heading', { name: GREETING })).toBeVisible();
  await page.getByRole('textbox', { name: /Ask anything/ }).fill(`Where is the ${TOKEN} lamp?`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page).toHaveURL(/\/ask\?q=/);
  await answerIsSafe(page);
  await expect(page.locator('section[aria-label="Answer"]').getByText(HOSTILE, { exact: true })).toBeVisible();
  await noOverflow(page, '/ask');
  await page.screenshot({ path: 'playwright/.auth/ask-phone.png', fullPage: true });

  // Valuable: Ask never shows it, not even to the owner
  await page.goto(`/things/${thing.data.id}`);
  await page.getByRole('switch', { name: 'Valuable' }).click();
  await expect(page.getByRole('switch', { name: 'Valuable' })).toHaveAttribute('aria-checked', 'true');
  await page.goto('/settings/ask');
  await expect(page.getByText(HOSTILE, { exact: true })).toBeVisible();
  await page.goto(`/ask?q=${encodeURIComponent(`Where is the ${TOKEN} lamp?`)}`);
  await answerIsSafe(page);
  await expect(page.locator('section[aria-label="Answer"]').getByText(HOSTILE, { exact: true })).toHaveCount(0);

  // An OTP-looking question is refused in the function before anything is counted or sent
  const used = await db.rpc('rpc_ask_status', { p_household: household });
  await page.getByRole('textbox', { name: /Ask anything/ }).fill('My OTP is 482913, what did I buy?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('looks like a code or password');
  const after = await db.rpc('rpc_ask_status', { p_household: household });
  expect((after.data as { used: number }).used).toBe((used.data as { used: number }).used);

  // Ctrl+K: a question gets its answer inside the palette
  await page.goto('/');
  await expect(page.getByRole('heading', { name: GREETING })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill("What's due this month?");
  await expect(page.getByRole('option', { name: /Ask Gedara: “What's due this month\?”/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await answerIsSafe(page);
  await page.screenshot({ path: 'playwright/.auth/ask-palette.png' });
});
