import { useEffect, useState } from 'react';

const SHARE_CACHE = 'gedara-share';
const SHARE_KEY = '/__shared-text';
// One read per share (React may run the effect twice in development).
const reads = new Map<number, Promise<string | null>>();

async function takeShared(): Promise<string | null> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const hit = await cache.match(SHARE_KEY);
    if (!hit) return null;
    const value = await hit.text();
    await cache.delete(SHARE_KEY);
    return value.trim() ? value : null;
  } catch {
    return null; // no Cache API (private mode): nothing shared
  }
}

/**
 * Text shared into Gedara from another app (Android share sheet): the service worker stored it
 * (sw.ts, share target); read it once and delete it, so a reload doesn't import it twice.
 */
export function useSharedText(stamp: number | undefined): string | undefined {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!stamp || typeof caches === 'undefined') return;
    let alive = true;
    if (!reads.has(stamp)) reads.set(stamp, takeShared());
    void reads.get(stamp)!.then((value) => {
      if (alive && value) setText(value);
    });
    return () => {
      alive = false;
    };
  }, [stamp]);
  return text;
}
