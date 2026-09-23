import { expect, test as setup } from '@playwright/test';
import { E2E_EMAIL, STORAGE_STATE, mintOtp } from './staging-guard';



setup('log in with an email OTP', async ({ page }) => {
  // Don't send a real email: pretend the OTP request succeeded, then use an admin-minted code.
  await page.route('**/auth/v1/otp**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(E2E_EMAIL);
  await page.getByRole('button', { name: 'Send code' }).click();

  const otp = await mintOtp();
  await page.getByLabel('Login code').fill(otp);

  await expect(page.getByRole('heading', { name: /Welcome to Gedara/ })).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE });
});
