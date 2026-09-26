import { expect, test } from '@playwright/test';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7: the owner connects the Bill Scanner's Drive folder in Money › Import › From Drive. The
// folder stays connected afterwards (it is the household's real one on staging); what Drive answers
// (files, or "not shared with the reader") is printed so a missing share is easy to spot.
test.use({ storageState: STORAGE_STATE });

const FOLDER = process.env.E2E_DRIVE_FOLDER ?? '1RRi58i0RYJyVlLmJDpFoB7wE2vbxqosb';

test('drive: the owner connects the scanner folder', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ipad-1024', 'one household setting: runs once');
  test.setTimeout(90_000);
  await page.goto('/money/import?tab=drive');
  const link = page.getByLabel('Drive folder link');
  await expect(link.or(page.getByTestId('drive-inbox'))).toBeVisible({ timeout: 30_000 });
  if (await link.isVisible()) {
    await link.fill(`https://drive.google.com/drive/u/0/folders/${FOLDER}`);
    await page.getByRole('button', { name: 'Connect' }).click();
  }
  await expect(page.getByTestId('drive-inbox')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Something went wrong' })).toHaveCount(0);

  const { data, error } = await stagingAdmin().from('drive_source').select('folder_id, last_sync_at, last_error').single();
  if (error) throw error;
  expect(data.folder_id).toBe(FOLDER);
  const files = await stagingAdmin().from('scan_file').select('name, doc_type, parse_error');
  console.log('drive_source:', JSON.stringify(data), '· files:', JSON.stringify(files.data));
});
