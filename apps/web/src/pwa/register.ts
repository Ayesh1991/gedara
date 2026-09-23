import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { APP_VERSION } from '@/lib/version';

const UPDATED_KEY = 'gedara:updated-to';

/** Registers the worker; when a new version takes control, reload once and say so. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Announce after the reload that brought the new version in.
  try {
    const updated = sessionStorage.getItem(UPDATED_KEY);
    if (updated) {
      sessionStorage.removeItem(UPDATED_KEY);
      toast.success(i18n.t('app.updated', { version: APP_VERSION }));
    }
  } catch {
    // storage unavailable (private mode) — skip the toast
  }

  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install takes control without a reload; only reload for real updates.
    if (!hadController) {
      hadController = true;
      return;
    }
    try {
      sessionStorage.setItem(UPDATED_KEY, '1');
    } catch {
      // ignore
    }
    window.location.reload();
  });

  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      // Check for a new deploy whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration?.update();
      });
    },
  });
}

/** On a first visit the worker takes control a moment after load; wait briefly for it. */
function waitForController(timeoutMs: number): Promise<ServiceWorker | null> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return Promise.resolve(null);
  if (sw.controller) return Promise.resolve(sw.controller);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(sw.controller), timeoutMs);
    sw.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(sw.controller);
      },
      { once: true },
    );
  });
}

/** Asks the active worker for its version (Diagnostics). */
export async function getServiceWorkerVersion(timeoutMs = 2000): Promise<string | null> {
  const controller = await waitForController(5000);
  if (!controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<{ version?: string }>) => {
      clearTimeout(timer);
      resolve(event.data.version ?? null);
    };
    controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  });
}

/** Unregister every worker, drop every cache, reload from the network. */
export async function clearCacheAndReload() {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  window.location.reload();
}
