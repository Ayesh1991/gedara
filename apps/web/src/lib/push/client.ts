// Turning notifications on/off on THIS device (Web Push, MASTER_PLAN §4 row 7, §11.3).
// The VAPID public key comes from the attention-push Edge Function (GET), so no key lives in the
// app bundle; the private key never leaves the function's secrets.
import { b64urlDecode, b64urlEncode } from '@push/webpush';
import { supabase } from '../supabase';

export type PushSupport = 'ok' | 'needs-install' | 'unsupported';

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ says it is a Mac; touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone / iPad only allow push for a Home-Screen app (iOS 16.4+); the feed works without it. */
export function pushSupport(): PushSupport {
  const hasApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return 'needs-install';
  return hasApi ? 'ok' : 'unsupported';
}

export async function vapidPublicKey(): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke('attention-push', { method: 'GET' });
  if (error) throw error;
  const key = (data as { vapid_public_key?: unknown } | null)?.vapid_public_key;
  return typeof key === 'string' && /^[A-Za-z0-9_-]{87}$/.test(key) ? key : null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('no-service-worker');
  return reg;
}

/** This browser's current subscription (null when notifications are off here). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** A readable default name for this device: "iPhone", "Android", "Windows · Edge" … */
export function deviceLabel(ua = navigator.userAgent): string {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Macintosh/.test(ua)
            ? 'Mac'
            : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser && os !== 'iPhone' && os !== 'iPad' ? `${os} · ${browser}` : os;
}

/** Ask permission, subscribe with our public key and store the subscription (the RPC moves a shared device to you). */
export async function enablePush(householdId: string): Promise<'on' | 'denied' | 'not-configured'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const key = await vapidPublicKey();
  if (!key) return 'not-configured';
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (e.g. keys were rotated) must be replaced.
  const current = sub?.options.applicationServerKey;
  if (sub && current && b64urlEncode(new Uint8Array(current)) !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(key) });
  const json = sub.toJSON();
  const { error } = await supabase.rpc('rpc_push_subscribe', {
    p: {
      household_id: householdId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      label: deviceLabel(),
      user_agent: navigator.userAgent.slice(0, 300),
    },
  });
  if (error) {
    await sub.unsubscribe().catch(() => undefined);
    throw error;
  }
  return 'on';
}

/** Turn off here: unsubscribe in the browser and delete our row. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  const { error } = await supabase.from('push_subscription').delete().eq('endpoint', endpoint);
  if (error) throw error;
}

export async function sendTestPush(subscriptionId?: string): Promise<{ sent: number; failed: number }> {
  const { data, error } = await supabase.functions.invoke('attention-push', {
    body: subscriptionId ? { test: true, subscription_id: subscriptionId } : { test: true },
  });
  if (error) throw error;
  const d = data as { sent?: number; failed?: number };
  return { sent: d.sent ?? 0, failed: d.failed ?? 0 };
}
