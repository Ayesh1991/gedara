import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('login screen shows brand, invite-only copy and the version badge', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Gedara', { exact: true })).toBeVisible();
  await expect(page.getByText('ගෙදර')).toBeVisible();
  await expect(page.getByText(/invite-only/)).toBeVisible();
  await expect(page.getByTestId('version-badge')).toHaveText(/^v\d+\.\d+\.\d+ · \w{5,7} · db \d+ · \w+$/);
});

test('protected pages redirect to login and remember where you were going', async ({ page }) => {
  await page.goto('/settings/diagnostics');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Fdiagnostics$/);
});

test('a scanned label URL survives the trip through login', async ({ page }) => {
  await page.goto('/s/HL:LOC:7K2P9Q');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fs%2FHL%3ALOC%3A7K2P9Q$/);
});

test('no horizontal scroll on the login screen', async ({ page }) => {
  await page.goto('/login');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('service worker: the shell still opens offline', async ({ page, context }) => {
  await page.goto('/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });
  await page.reload(); // shell assets now go through the worker
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('ගෙදර').first()).toBeVisible();
  await context.setOffline(false);
});
