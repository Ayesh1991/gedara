import { expect, test } from '@playwright/test';
import { STORAGE_STATE } from './staging-guard';

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

test('diagnostics: all green even as the very first page (SW still installing)', async ({ page }) => {
  await page.goto('/settings/diagnostics');
  // Wait for all six checks to finish, then report every row so a failure names its check.
  await expect(page.getByTestId('diag-summary')).toBeVisible({ timeout: 30_000 });
  const rows = await Promise.all(
    ['auth', 'db', 'storage', 'realtime', 'edge', 'sw'].map(async (id) => {
      const row = page.getByTestId(`check-${id}`);
      return { id, ok: await row.getAttribute('data-ok'), text: (await row.innerText()).replace(/\s+/g, ' ') };
    }),
  );
  expect(rows.filter((r) => r.ok !== 'true'), JSON.stringify(rows, null, 1)).toEqual([]);
  await expect(page.getByTestId('diag-summary')).toHaveText('All green');
});
