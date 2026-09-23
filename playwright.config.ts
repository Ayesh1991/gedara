import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const local = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', serviceWorkers: 'allow' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'phone-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true },
      dependencies: ['setup'],
    },
    {
      name: 'ipad-1024',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 1366 }, hasTouch: true },
      dependencies: ['setup'],
    },
  ],
  // Preview (not dev) so the real service worker is built and registered.
  webServer: local
    ? {
        command: 'pnpm --filter @gedara/web build && pnpm --filter @gedara/web preview --port 4173 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
      }
    : undefined,
});
