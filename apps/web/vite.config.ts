import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function gitSha(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'nogit';
  }
}

const APP_VERSION = pkg.version;

export default defineConfig({
  // .env.local lives at the repo root (one file for web, scripts and e2e).
  envDir: path.resolve(import.meta.dirname, '../..'),
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __GIT_SHA__: JSON.stringify(gitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: {
        // The list only warms the NetworkFirst cache on install; nothing is served cache-first.
        globPatterns: ['index.html', 'assets/*.{js,css}', '*.{png,svg,ico}'],
        buildPlugins: {
          vite: [
            {
              name: 'gedara-sw-version',
              config: () => ({ define: { __APP_VERSION__: JSON.stringify(APP_VERSION) } }),
            },
          ],
        },
      },
      manifest: {
        name: 'Gedara',
        short_name: 'Gedara',
        description: 'Household ledger, pantry and things',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0B101C',
        theme_color: '#0B101C',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
