// The Phase 7 done-when "Lighthouse PWA ✓, works offline for scan-and-consume", checked by a script.
// Lighthouse 12 removed its PWA category, so this repeats those audits (installable manifest,
// icons, service worker in control, offline start) plus what Gedara needs offline: the app shell
// for the scan / pantry / list screens and the barcode-scanner WASM in the cache.
//
// Usage: node scripts/pwa-check.mjs [base URL]   (default http://localhost:4173 = `vite preview`)
// Uses Playwright with Edge (E2E_CHANNEL from .env.local) like the e2e tests. Exit code 1 on failure.
import { chromium } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });
const base = (process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chromium' });
const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 375, height: 812 } });
const page = await context.newPage();

try {
  // ── Installability (the old Lighthouse PWA audits) ────────────────────────
  const res = await page.goto(`${base}/`, { waitUntil: 'load' });
  check('Page answers', res?.ok(), `HTTP ${res?.status()}`);
  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
    appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    lang: document.documentElement.lang,
  }));
  check('Manifest linked', head.manifest, head.manifest ?? 'missing');
  check('Apple touch icon', head.appleIcon, head.appleIcon ?? 'missing');
  check('Theme colour meta', head.themeColor, head.themeColor ?? 'missing');
  check('Mobile viewport', head.viewport.includes('width=device-width'), head.viewport);
  check('Document language', head.lang, head.lang);

  const manifest = head.manifest ? await (await page.request.get(new URL(head.manifest, `${base}/`).href)).json() : {};
  const icons = manifest.icons ?? [];
  const has = (size, purpose) => icons.some((i) => (i.sizes ?? '').split(' ').includes(size) && (!purpose || (i.purpose ?? '').includes(purpose)));
  check('Manifest name + short_name', manifest.name && manifest.short_name, `${manifest.name} / ${manifest.short_name}`);
  check('start_url inside scope', manifest.start_url && new URL(manifest.start_url, base).href.startsWith(new URL(manifest.scope ?? '/', base).href), `${manifest.start_url} in ${manifest.scope}`);
  check('Display standalone', ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), manifest.display);
  check('Icon 192 px', has('192x192'));
  check('Icon 512 px', has('512x512'));
  check('Maskable icon', has('512x512', 'maskable'));
  check('Theme + background colour', manifest.theme_color && manifest.background_color, `${manifest.theme_color} / ${manifest.background_color}`);
  check('Share target (Android)', manifest.share_target?.action === '/share-target' && manifest.share_target?.method === 'POST', manifest.share_target?.action ?? 'none');
  for (const i of icons.filter((x) => x.sizes === '192x192' || x.sizes === '512x512')) {
    const r = await page.request.get(new URL(i.src, `${base}/`).href);
    check(`Icon ${i.src} loads`, r.ok() && (r.headers()['content-type'] ?? '').startsWith('image/'), r.headers()['content-type']);
  }

  // ── Service worker in control, caches warmed ───────────────────────────────
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload({ waitUntil: 'load' });
  const sw = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  check('Service worker controls the page', sw);
  // Wait for the install-time warm-up (shell + scanner WASM).
  let cached = { shell: 0, wasm: false };
  for (let i = 0; i < 30; i++) {
    cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      let shell = 0;
      let wasm = false;
      for (const k of keys.filter((x) => x.startsWith('gedara-shell-'))) {
        const reqs = await (await caches.open(k)).keys();
        shell += reqs.length;
        wasm ||= reqs.some((r) => /zxing_reader-.*\.wasm$/.test(r.url));
      }
      return { shell, wasm };
    });
    if (cached.shell > 20 && cached.wasm) break;
    await page.waitForTimeout(500);
  }
  check('App shell cached for offline', cached.shell > 20, `${cached.shell} files`);
  check('Barcode scanner (WASM) cached', cached.wasm);

  // ── Offline start ──────────────────────────────────────────────────────────
  await context.setOffline(true);
  for (const path of ['/', '/scan', '/pantry', '/pantry/list']) {
    const p = await context.newPage();
    let ok = false;
    let detail = '';
    try {
      const r = await p.goto(`${base}${path}`, { waitUntil: 'load', timeout: 15_000 });
      await p.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 10_000 });
      ok = Boolean(r?.ok());
      detail = `HTTP ${r?.status()} from ${r?.fromServiceWorker() ? 'service worker' : 'network'}`;
    } catch (e) {
      detail = String(e).split('\n')[0];
    }
    check(`Offline: ${path} opens`, ok, detail);
    await p.close();
  }
  await context.setOffline(false);
} finally {
  await browser.close();
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail ?? ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? '' : ' — PWA ✓'}`);
process.exit(failed ? 1 : 0);
