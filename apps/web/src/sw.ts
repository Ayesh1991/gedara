/// <reference lib="webworker" />
// Gedara service worker — NETWORK-FIRST (rule 7, HANDOVER §4).
// Lesson from ledger v1–v6: a cache-first worker silently served v1.0 for six releases.
// Here the network always wins when online; caches are only an offline fallback.
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import type { PrecacheEntry } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

const VERSION = __APP_VERSION__;
const SHELL_CACHE = `gedara-shell-${VERSION}`;
const MEDIA_CACHE = `gedara-media-${VERSION}`;
const INDEX_URL = new URL('index.html', self.registration.scope).href;

// Build-time list of shell files. Used only to warm the offline cache on install —
// nothing is ever served from it while the network works.
// De-duplicated: the plugin lists the manifest icons a second time, and Cache.addAll() rejects the
// WHOLE list on a duplicate — which silently left the offline cache empty until Phase 7.
const SHELL_URLS = [
  ...new Set(self.__WB_MANIFEST.map((e) => new URL(typeof e === 'string' ? e : e.url, self.registration.scope).href)),
];

void self.skipWaiting();
clientsClaim();

// One file at a time: Cache.addAll() is all-or-nothing, so a single slow or failed request would
// leave the whole offline shell empty. Files already cached (same hashed URL) are skipped.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const queue = [...SHELL_URLS];
      const worker = async () => {
        for (let url = queue.shift(); url; url = queue.shift()) {
          if (await cache.match(url, { ignoreVary: true })) continue;
          await cache.add(url).catch(() => cache.add(url).catch(() => undefined));
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('gedara-') && k !== SHELL_CACHE && k !== MEDIA_CACHE && k !== SHARE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

// Diagnostics asks the worker which version it is.
self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});

// Supabase (API, Auth, Storage, Realtime, Edge Functions): never cached.
registerRoute(({ url }) => url.hostname.endsWith('.supabase.co'), new NetworkOnly());

// App HTML: network first with no timeout, so a slow link never shows an old shell.
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({ cacheName: SHELL_CACHE, matchOptions: { ignoreVary: true } }),
);

// Hashed JS/CSS: network first; a timeout is safe because a hashed URL never changes content.
registerRoute(
  ({ request, url }) =>
    url.origin === self.location.origin &&
    (request.destination === 'script' || request.destination === 'style' || request.destination === 'worker'),
  // ignoreVary: lazy route chunks are fetched with an Origin header; a server that answers with
  // `Vary: Origin` (vite preview) would otherwise make the warmed copy unmatchable offline.
  new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4, matchOptions: { ignoreVary: true } }),
);

// Scanner / image-encoder WASM (hashed, same origin): network first, cached for offline scanning.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.endsWith('.wasm'),
  new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4, matchOptions: { ignoreVary: true } }),
);

// Images and fonts: stale-while-revalidate (MASTER_PLAN §2).
registerRoute(
  ({ request }) => request.destination === 'image' || request.destination === 'font',
  new StaleWhileRevalidate({
    cacheName: MEDIA_CACHE,
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  }),
);

// Android share target (manifest share_target): keep the shared text for ONE read by Money › Import
// and open it there. Bill data never goes into a URL. Capped at 2 MB; only text / JSON files.
const SHARE_CACHE = 'gedara-share';
const SHARE_KEY = new URL('/__shared-text', self.registration.scope).href;
const SHARE_MAX = 2 * 1024 * 1024;
registerRoute(
  ({ url, request }) => url.origin === self.location.origin && url.pathname === '/share-target' && request.method === 'POST',
  async ({ request }) => {
    let text: string;
    try {
      const form = await request.formData();
      const file = form.getAll('files').find((f): f is File => f instanceof File && f.size > 0 && f.size <= SHARE_MAX);
      if (file && /^(application\/json|text\/plain|)$/.test(file.type)) text = await file.text();
      else text = [form.get('text'), form.get('url')].filter((v): v is string => typeof v === 'string').join(' ');
    } catch {
      text = '';
    }
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(SHARE_KEY, new Response(text.slice(0, SHARE_MAX), { headers: { 'Content-Type': 'text/plain' } }));
    return Response.redirect(new URL(`/money/import?tab=bill&shared=${Date.now()}`, self.registration.scope).href, 303);
  },
  'POST',
);

// Offline and the page was never visited: fall back to the cached shell (SPA router takes over).
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const shell = await caches.match(INDEX_URL, { cacheName: SHELL_CACHE, ignoreVary: true });
    if (shell) return shell;
  }
  return Response.error();
});

// ── Web Push (Phase 6): the daily Attention summary from the attention-push Edge Function ─────
// iOS requires every push to show a notification (no silent pushes), so we always show one.
interface PushMessage {
  title?: unknown;
  body?: unknown;
  url?: unknown;
  tag?: unknown;
  count?: unknown;
}

self.addEventListener('push', (event) => {
  let msg: PushMessage;
  try {
    msg = (event.data?.json() ?? {}) as PushMessage;
  } catch {
    msg = { body: event.data?.text() };
  }
  // Only same-app paths: a notification can never send the app to another site.
  const url = typeof msg.url === 'string' && msg.url.startsWith('/') && !msg.url.startsWith('//') ? msg.url : '/attention';
  const count = typeof msg.count === 'number' ? msg.count : null;
  const nav = self.navigator as WorkerNavigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(typeof msg.title === 'string' ? msg.title : 'Gedara', {
        body: typeof msg.body === 'string' ? msg.body : '',
        tag: typeof msg.tag === 'string' ? msg.tag : 'gedara-attention',
        icon: new URL('pwa-192x192.png', self.registration.scope).href,
        badge: new URL('pwa-64x64.png', self.registration.scope).href,
        data: { url },
      }),
      count === null
        ? Promise.resolve()
        : (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => undefined) ?? Promise.resolve(),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data as { url?: unknown } | null)?.url;
  const target = new URL(typeof path === 'string' ? path : '/attention', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const mine = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (mine) {
        await mine.focus();
        await mine.navigate(target).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
