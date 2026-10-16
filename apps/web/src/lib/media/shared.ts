// Songs shared to Gedara on Android (Share → Gedara, Phase 7h). The service worker (src/sw.ts) keeps
// them in the `gedara-share` cache and opens Music with ?shared=…; this reads them ONCE and forgets
// them, so they are never uploaded twice.
const SHARE_CACHE = 'gedara-share';

export async function takeSharedAudio(): Promise<File[]> {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const indexUrl = new URL('/__shared-audio', window.location.origin).href;
    const index = await cache.match(indexUrl);
    if (!index) return [];
    const names = (await index.json()) as unknown;
    await cache.delete(indexUrl);
    if (!Array.isArray(names)) return [];
    const files: File[] = [];
    for (const [i, name] of names.slice(0, 20).entries()) {
      const key = `${indexUrl}/${i}`;
      const res = await cache.match(key);
      await cache.delete(key);
      if (!res) continue;
      const blob = await res.blob();
      files.push(new File([blob], typeof name === 'string' ? name.slice(0, 255) : `song-${i + 1}`, { type: blob.type }));
    }
    return files;
  } catch {
    return [];
  }
}
