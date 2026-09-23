import { expect, test } from '@playwright/test';
import { STORAGE_STATE } from './auth.setup';

test.use({ storageState: STORAGE_STATE });

test('shell: tabs navigate and nothing scrolls sideways', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome to Gedara/ })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true });
  for (const [tab, heading] of [
    ['Money', 'Money'],
    ['Pantry', 'Pantry'],
    ['Things', 'Things'],
  ] as const) {
    await nav.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Scan' }).click();
  await expect(page.getByRole('heading', { name: 'Scan', level: 1 })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('diagnostics: test connection is all green', async ({ page }) => {
  await page.goto('/');
  // Wait until the service worker controls the page, so the SW check can pass.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });
  await page.goto('/settings/diagnostics');
  await expect(page.getByTestId('diag-summary')).toHaveText('All green', { timeout: 30_000 });
  for (const id of ['auth', 'db', 'storage', 'realtime', 'edge', 'sw']) {
    await expect(page.getByTestId(`check-${id}`)).toHaveAttribute('data-ok', 'true');
  }
});
