// Offline catalogue: the few queries a scan-and-use needs are kept in IndexedDB, so the app opens
// and resolves scans with no network (MASTER_PLAN §9 Phase 7). Structured clone (not JSON), so the
// unit Map survives. Only allow-listed queries with data are saved; a new app version or
// 7 days without a refresh throws the copy away.
import { persistQueryClientRestore, persistQueryClientSubscribe, type PersistedClient, type Persister } from '@tanstack/query-persist-client-core';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { createStore, del, get, set } from 'idb-keyval';
import { APP_VERSION } from '../version';

export const OFFLINE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const KEY = 'query-cache';
const PANTRY_PARTS = new Set(['units', 'products', 'conversions', 'barcodes']);

/** Membership, pantry units/products/conversions/barcodes, places, the shopping list. (Not money
 *  categories: forms that pick one must never start from an old copy, and scan-and-use doesn't need them.) */
export function shouldPersist(key: QueryKey): boolean {
  const [a, , c] = key;
  if (a === 'membership') return key.length === 1;
  if (a === 'pantry') return key.length === 3 && typeof c === 'string' && PANTRY_PARTS.has(c);
  if (a === 'places' || a === 'shopping') return key.length === 2;
  return false;
}

let store: ReturnType<typeof createStore> | null = null;
const idb = () => (store ??= createStore('gedara-cache', 'kv'));

function idbPersister(throttleMs = 1000): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: PersistedClient | null = null;
  const writeNow = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const c = latest;
    latest = null;
    if (c) void set(KEY, c, idb()).catch(() => undefined);
  };
  // A reload or a closed tab right after a change must not lose the last copy.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', writeNow);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && writeNow());
  }
  return {
    persistClient(client) {
      latest = client;
      if (!timer) timer = setTimeout(writeNow, throttleMs);
    },
    restoreClient: () => get<PersistedClient>(KEY, idb()).catch(() => undefined),
    removeClient: () => del(KEY, idb()).catch(() => undefined),
  };
}

const persister = idbPersister();
const options = (queryClient: QueryClient) => ({
  queryClient,
  persister,
  buster: APP_VERSION,
  maxAge: OFFLINE_MAX_AGE,
  dehydrateOptions: {
    // Keep the last good data even when the latest refresh failed (offline): dropping it here would
    // leave the next offline start with nothing.
    shouldDehydrateQuery: (q: { queryKey: QueryKey; state: { data: unknown } }) =>
      q.state.data !== undefined && shouldPersist(q.queryKey),
  },
});

/** Restore the saved catalogue (bounded wait: a slow IndexedDB must not delay the first paint much). */
export async function restoreOfflineCache(queryClient: QueryClient): Promise<void> {
  // Kept queries must outlive their last observer, or they'd be garbage-collected and dropped.
  for (const k of [['membership'], ['pantry'], ['places'], ['shopping']]) {
    queryClient.setQueryDefaults(k, { gcTime: OFFLINE_MAX_AGE });
  }
  try {
    await Promise.race([
      persistQueryClientRestore(options(queryClient)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // No IndexedDB (private mode …): simply online-only.
  }
  // The saved copy is shown at once but never trusted as fresh: every screen refreshes it on open.
  void queryClient.invalidateQueries({ refetchType: 'none' });
  persistQueryClientSubscribe(options(queryClient));
}

export function clearOfflineCache(): Promise<void> {
  return Promise.resolve(persister.removeClient());
}
