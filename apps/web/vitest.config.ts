import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __GIT_SHA__: JSON.stringify('testsha'),
    __BUILD_TIME__: JSON.stringify('2026-01-01T00:00:00.000Z'),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@sms': path.resolve(import.meta.dirname, '../../supabase/functions/_shared/sms'),
      '@push': path.resolve(import.meta.dirname, '../../supabase/functions/_shared/push'),
      // Scanner-JSON schemas + ledger-v7 fingerprints shared with the drive-scan Edge Function. They
      // import zod, which must resolve to the app's copy from outside apps/web (Deno maps it itself).
      '@scan': path.resolve(import.meta.dirname, '../../supabase/functions/_shared/scan'),
      zod: path.resolve(import.meta.dirname, 'node_modules/zod'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
