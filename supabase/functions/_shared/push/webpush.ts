// Web Push with nothing but WebCrypto + fetch (runs in Deno Edge Functions, Node ≥ 20 and browsers).
//   RFC 8291  message encryption (aes128gcm content coding, RFC 8188)
//   RFC 8292  VAPID: an ES256 JWT that proves the push comes from our server
// No imports on purpose: the same file is unit-tested from the web app's vitest (encrypt → decrypt).
//
// Keys are base64url strings: the VAPID public key is the uncompressed P-256 point (65 bytes, the
// browser's applicationServerKey), the private key its 32-byte scalar `d`.

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateKey: string; subject: string };
export type PushOptions = { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string };
export type PushResult = { ok: boolean; status: number; error?: string };

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** The JWK of a P-256 key from its raw public point (+ private scalar). */
export function p256Jwk(publicRaw: Uint8Array, privateD?: Uint8Array): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error('not an uncompressed P-256 point');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
    ext: true,
  };
  if (privateD) jwk.d = b64urlEncode(privateD);
  return jwk;
}

/**
 * RFC 8291 encryption of one push message → the aes128gcm body.
 * `salt` and `asKeyPair` are for tests; normally both are fresh per message.
 */
export async function encryptPayload(
  payload: Uint8Array,
  sub: { p256dh: string; auth: string },
  test?: { salt: Uint8Array<ArrayBuffer>; asKeyPair: CryptoKeyPair },
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');

  const asKeys =
    test?.asKeyPair ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  );

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(payload, new Uint8Array([2])); // 0x02 = last (only) record, no padding
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plaintext));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin (valid 12 h). */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)) {
  const publicRaw = b64urlDecode(vapid.publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    p256Jwk(publicRaw, b64urlDecode(vapid.privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: vapid.subject })),
  );
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are raw r‖s (IEEE P1363) — exactly what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

/** Encrypt and POST one message. 404 / 410 mean the browser dropped the subscription. */
export async function sendPush(
  sub: PushSubscriptionKeys,
  message: unknown,
  vapid: VapidKeys,
  options: PushOptions = {},
): Promise<PushResult> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub);
    const headers: Record<string, string> = {
      TTL: String(options.ttl ?? 12 * 3600),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Urgency: options.urgency ?? 'normal',
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
    };
    if (options.topic) headers.Topic = options.topic;
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, status: res.status, error: `${res.status} ${text}`.trim() };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message.slice(0, 200) : 'failed' };
  }
}

/** A fresh VAPID key pair as base64url strings (used by scripts/vapid-keys.mjs's twin and tests). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(publicRaw), privateKey: jwk.d ?? '' };
}
