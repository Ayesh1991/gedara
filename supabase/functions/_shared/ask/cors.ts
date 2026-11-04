// Ask Gedara, part 4: only Gedara's own pages may call ask-gedara from a browser (Phase 10). Production,
// Vercel previews of this project, and the local dev / preview servers. A request without an Origin (a
// script, the accuracy run, e2e) still needs a member's login; CORS only stops other websites' pages.

const ALLOWED: RegExp[] = [
  /^https:\/\/gedara\.vercel\.app$/,
  /^https:\/\/gedara-[a-z0-9-]+-ayeshmantha\.vercel\.app$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1):(?:5173|4173|4174)$/,
];

export function originAllowed(origin: string | null): boolean {
  return origin !== null && origin.length <= 100 && ALLOWED.some((re) => re.test(origin));
}

/** CORS headers for an allowed origin; none at all for anyone else (the browser then blocks the reply). */
export function corsFor(origin: string | null): Record<string, string> {
  if (!originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
