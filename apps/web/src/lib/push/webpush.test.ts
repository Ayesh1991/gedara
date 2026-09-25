import { describe, expect, it } from 'vitest';
import { digestMessage, itemPhrase } from '@push/digest';
import {
  b64urlDecode,
  b64urlEncode,
  concat,
  encryptPayload,
  generateVapidKeys,
  p256Jwk,
  vapidAuthorization,
} from '@push/webpush';

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** What the browser does on receipt (RFC 8291 §3.4, RFC 8188): the other half of the round trip. */
async function decrypt(body: Uint8Array<ArrayBuffer>, ua: CryptoKeyPair, authSecret: Uint8Array<ArrayBuffer>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  return { rs, idlen, plain };
}

describe('web push encryption (RFC 8291)', () => {
  it('round-trips a message the way a browser decrypts it', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const sub = {
      p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))),
      auth: b64urlEncode(authSecret),
    };
    const message = JSON.stringify({ title: '3 things need attention', body: 'Milk has expired' });
    const body = await encryptPayload(enc.encode(message), sub);
    const { rs, idlen, plain } = await decrypt(body, ua, authSecret);
    expect(rs).toBe(4096);
    expect(idlen).toBe(65);
    expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message);
  });

  it('uses a fresh salt and key for every message', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const sub = {
      p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    const a = await encryptPayload(enc.encode('x'), sub);
    const b = await encryptPayload(enc.encode('x'), sub);
    expect(b64urlEncode(a.slice(0, 86))).not.toBe(b64urlEncode(b.slice(0, 86)));
  });

  it('refuses malformed subscription keys', async () => {
    await expect(encryptPayload(enc.encode('x'), { p256dh: 'AAAA', auth: 'AAAA' })).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT for the push service origin that verifies with the public key', async () => {
    const keys = await generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const header = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      { ...keys, subject: 'mailto:someone@example.com' },
      1_800_000_000,
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c!)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_800_000_000 + 12 * 3600,
      sub: 'mailto:someone@example.com',
    });
    const pub = await crypto.subtle.importKey('jwk', p256Jwk(b64urlDecode(keys.publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(s!), enc.encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });
});

describe('the daily digest text', () => {
  it('names the most urgent three and counts the rest', () => {
    const m = digestMessage(5, [
      { kind: 'expired', severity: 'red', title: 'Yoghurt', days_left: -1, qty: 1 },
      { kind: 'bill_due', severity: 'cyan', title: 'CEB', days_left: 2, qty: null },
      { kind: 'warranty_ending', severity: 'cyan', title: 'Fridge', days_left: 1, qty: null },
      { kind: 'below_min', severity: 'violet', title: 'Rice', days_left: null, qty: 1000 },
    ]);
    expect(m.title).toBe('5 things need attention');
    expect(m.body).toBe('Yoghurt has expired · CEB is due in 2 days · Fridge warranty ends tomorrow · +2 more');
    expect(m.url).toBe('/attention');
  });

  it('says overdue, today and counts naturally', () => {
    expect(itemPhrase({ kind: 'bill_due', severity: 'red', title: 'Water', days_left: -3, qty: null })).toBe('Water is overdue');
    expect(itemPhrase({ kind: 'service_due', severity: 'cyan', title: 'AC', days_left: 0, qty: null })).toBe('AC service is due today');
    expect(itemPhrase({ kind: 'things_pending', severity: 'violet', title: null, days_left: null, qty: 1 })).toBe('1 thing to enter');
    expect(itemPhrase({ kind: 'sms_review', severity: 'violet', title: null, days_left: null, qty: '4' })).toBe('4 bank alerts to review');
    expect(digestMessage(1, [{ kind: 'budget_over', severity: 'red', title: 'Grocery', days_left: null, qty: null }])).toMatchObject({
      title: '1 thing needs attention',
      body: 'Grocery budget is over',
    });
  });
});
