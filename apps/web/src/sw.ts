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
const SHELL_URLS = self.__WB_MANIFEST.map((e) =>
  new URL(typeof e === 'string' ? e : e.url, self.registration.scope).href,
);

void self.skipWaiting();
clientsClaim();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('gedara-') && k !== SHELL_CACHE && k !== MEDIA_CACHE)
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
registerRoute(({ request }) => request.mode === 'navigate', new NetworkFirst({ cacheName: SHELL_CACHE }));

// Hashed JS/CSS: network first; a timeout is safe because a hashed URL never changes content.
registerRoute(
  ({ request, url }) =>
    url.origin === self.location.origin &&
    (request.destination === 'script' || request.destination === 'style' || request.destination === 'worker'),
  new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4 }),
);

// Scanner / image-encoder WASM (hashed, same origin): network first, cached for offline scanning.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.endsWith('.wasm'),
  new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4 }),
);

// Images and fonts: stale-while-revalidate (MASTER_PLAN §2).
registerRoute(
  ({ request }) => request.destination === 'image' || request.destination === 'font',
  new StaleWhileRevalidate({
    cacheName: MEDIA_CACHE,
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  }),
);

// Offline and the page was never visited: fall back to the cached shell (SPA router takes over).
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const shell = await caches.match(INDEX_URL, { cacheName: SHELL_CACHE });
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
