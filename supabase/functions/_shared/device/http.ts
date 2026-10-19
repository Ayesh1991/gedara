// HTTP helpers for the device Edge Functions that pair by code (home-agent; the same code lives in
// media-agent, which predates this file). No Supabase client here, so it is easy to test alone.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Postgres error code → HTTP status (42501 not allowed, GDRTE slow down, check/format errors). */
export function rpcStatus(code: string | undefined): number {
  if (code === '42501') return 401;
  if (code === 'GDRTE') return 429;
  if (code === '23514' || code === '22P02' || code === '22003' || code === '22007') return 400;
  return 500;
}

export function rpcError(code: string | undefined): Response {
  const status = rpcStatus(code);
  return json({ ok: false, error: status === 401 ? 'unauthorized' : status === 429 ? 'slow_down' : 'rejected' }, status);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The body, read as a stream that stops at maxBytes (a missing or false Content-Length can't get past it). */
export async function readBody(req: Request, maxBytes: number): Promise<unknown | Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return json({ ok: false, error: 'too_large' }, 413);
  if (!req.body) return json({ ok: false, error: 'bad_json' }, 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return json({ ok: false, error: 'too_large' }, 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
}

/**
 * sha256 of the caller's IP (with a purpose prefix): pairing is limited per caller without keeping
 * the address. Supabase's edge sits behind Cloudflare, which sets cf-connecting-ip itself; otherwise
 * the last X-Forwarded-For hop. No address at all counts in one shared "unknown" bucket.
 */
export async function sourceHash(req: Request): Promise<string> {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return await sha256Hex(`gedara-pairing:${cf || xff || 'unknown'}`);
}
