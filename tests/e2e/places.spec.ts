import { expect, test, type Page } from '@playwright/test';
import { E2E_EMAIL, STORAGE_STATE, mintOtp, stagingAdmin } from './staging-guard';

// Phase 1 "done when": a place gets a label, and its code / URL opens the place — typed, via a USB
// scanner burst, and through a deep link (also when signed out). Places are prefixed "E2E " and
// removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E ';

// Each project (phone / iPad) runs in its own worker: clean up only what this project created.
test.afterAll(async ({}, testInfo) => {
  const { error } = await stagingAdmin()
    .from('location')
    .delete()
    .like('name', `${PREFIX}%${testInfo.project.name}-%`);
  if (error) throw error;
});

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

async function addPlace(page: Page, opener: RegExp, name: string) {
  await page.getByRole('button', { name: opener }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Add place' }).click();
  await expect(dialog).toBeHidden();
}

test('places: add, drill in, label, scan and deep-link', async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const room = `${PREFIX}Room ${tag}`;
  const box = `${PREFIX}Box ${tag}`;

  // ── Create a room, then a box inside it ─────────────────────────────────────
  await page.goto('/places');
  await expect(page.getByRole('heading', { name: 'Places', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, '/places');
  await addPlace(page, /^(Add place|Add your first room)$/, room);
  await page.getByRole('link', { name: new RegExp(room) }).click();
  await expect(page.getByRole('heading', { name: room, level: 1 })).toBeVisible();

  await addPlace(page, /^Add a place inside$/, box);
  await page.getByRole('link', { name: new RegExp(box) }).click();
  await expect(page.getByRole('heading', { name: box, level: 1 })).toBeVisible();
  const crumbs = page.getByRole('navigation', { name: 'Where this place is' });
  await expect(crumbs.getByRole('link', { name: room })).toBeVisible();
  await noSidewaysScroll(page, 'place page');

  const code = (await page.getByText(/^HL:LOC:[0-9A-HJKMNP-TV-Z]{6}$/).first().textContent())!.trim();
  const boxUrl = page.url();

  // ── Deep link (A4 label URL) ─────────────────────────────────────────────────
  await page.goto(`/s/${code}`);
  await expect(page).toHaveURL(boxUrl);
  await expect(page.getByRole('heading', { name: box, level: 1 })).toBeVisible();

  // ── Scan screen: typed code (lower case, as someone would type it) ───────────
  await page.goto('/scan');
  await expect(page.getByRole('button', { name: 'Start camera' })).toBeVisible();
  await page.getByLabel('Or type the code').fill(code.toLowerCase());
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByTestId('scan-result').filter({ hasText: box })).toBeVisible();
  await noSidewaysScroll(page, '/scan');

  // ── USB scanner burst on another screen → result toast ───────────────────────
  await page.goto('/places');
  await expect(page.getByRole('heading', { name: 'Places', level: 1 })).toBeVisible();
  // A scanner types ~5–15 ms per key; Playwright's own key presses can be slower than that on a
  // busy PC, so fire the burst in the page at scanner speed.
  await page.evaluate((text) => {
    for (const key of [...text, 'Enter']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }, code);
  const toast = page.getByTestId('scan-result').filter({ hasText: box });
  await expect(toast).toBeVisible();
  await toast.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: box, level: 1 })).toBeVisible();

  // ── Labels: A4 PDF and NIIMBOT PNG ───────────────────────────────────────────
  await page.getByRole('button', { name: 'Label', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Labels', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, '/places/labels');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  const stream = await download.createReadStream();
  const head = await new Promise<string>((resolve, reject) => {
    stream.once('data', (chunk: Buffer) => resolve(chunk.subarray(0, 5).toString('latin1')));
    stream.once('error', reject);
  });
  expect(head).toBe('%PDF-');
  await page.getByRole('tab', { name: /NIIMBOT/ }).click();
  await expect(page.getByRole('img', { name: code })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PNG' })).toBeEnabled();

  // ── Delete with Undo ────────────────────────────────────────────────────────
  await page.goto(boxUrl);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: room, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.goto(boxUrl);
  await expect(page.getByRole('heading', { name: box, level: 1 })).toBeVisible();

  // ── Signed out: the label URL goes through login and comes back ──────────────
  // One project only: minting a code for the same email in two workers at once invalidates the
  // first code.
  if (testInfo.project.name !== 'phone-375') return;
  const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const other = await fresh.newPage();
  await other.route('**/auth/v1/otp**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await other.goto(`/s/${code}`);
  await expect(other).toHaveURL(/\/login\?redirect=/);
  await other.getByLabel('Email').fill(E2E_EMAIL);
  await other.getByRole('button', { name: 'Send code' }).click();
  await other.getByLabel('Login code').fill(await mintOtp());
  await expect(other.getByRole('heading', { name: box, level: 1 })).toBeVisible({ timeout: 20_000 });
  await fresh.close();
});
