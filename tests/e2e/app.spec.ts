import { expect, test } from '@playwright/test';
import { GREETING, STORAGE_STATE } from './staging-guard';

test.use({ storageState: STORAGE_STATE });

test('shell: tabs navigate and nothing scrolls sideways', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: GREETING })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true });
  for (const [tab, heading] of [
    ['Money', 'Money'],
    ['Pantry', 'Pantry'],
    ['Things', 'Things'],
  ] as const) {
    await nav.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  // Scan is the gold action: centre of the phone dock, top bar on desktop.
  await page.getByRole('link', { name: 'Scan' }).filter({ visible: true }).first().click();
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

test.describe('appearance', () => {
  // These change the owner's staging prefs, so run in order and restore the defaults.
  test.describe.configure({ mode: 'serial' });
  const stateful = (name: string) => name !== 'ipad-1024'; // one project only, or two workers race

  test('theme applies at once, survives a reload and follows the account to a new device', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(stateful(testInfo.project.name), 'runs once, on ipad-1024');
    await page.goto('/settings/appearance');
    await page.getByRole('radio', { name: /Nebula/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nebula');
    await expect(page.getByRole('radio', { name: /Nebula/ })).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nebula');

    // Same account on a "new device": session present, no local prefs, so the theme must come
    // from the account (user_metadata).
    await page.waitForTimeout(1500); // let the background save reach Supabase
    const state = await page.context().storageState();
    const fresh = await browser.newContext({
      storageState: {
        cookies: state.cookies,
        origins: state.origins.map((o) => ({
          ...o,
          localStorage: o.localStorage.filter((e) => e.name !== 'gedara:prefs'),
        })),
      },
    });
    const other = await fresh.newPage();
    await other.goto('/');
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'nebula', { timeout: 15_000 });
    await fresh.close();

    await page.getByRole('radio', { name: /Aurora/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'aurora');
    await page.waitForTimeout(1500);
  });

  test('motion off stops every animation', async ({ page }, testInfo) => {
    test.skip(stateful(testInfo.project.name), 'runs once, on ipad-1024');
    await page.goto('/settings/appearance');
    await page.getByRole('radio', { name: 'Off' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);

    await page.goto('/settings/appearance');
    await page.getByRole('radio', { name: 'Follow device' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'system');
    await page.waitForTimeout(1500);
  });

  test('no sideways scroll on Home, Settings, Appearance and Diagnostics', async ({ page }) => {
    for (const path of ['/', '/settings', '/settings/appearance', '/settings/diagnostics']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
