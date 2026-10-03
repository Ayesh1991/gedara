import { describe, expect, it } from 'vitest';
import { normaliseUid, SyncRequest } from '@scale/protocol';
import { checkFirmware, compareVersions, sha256Hex } from './espImage';
import { deviceOnline, formatDelta, formatGrams, formatLatency, latencyMs, needsAction, statusTone, wifiQuality } from './format';
import { containerTagUrl, readTag, writeTag, type NdefReaderLike } from './nfc';

describe('grams', () => {
  it('formats grams and kilograms', () => {
    expect(formatGrams(788)).toBe('788 g');
    expect(formatGrams(2.4)).toBe('2.4 g');
    expect(formatGrams(1250)).toBe('1.25 kg');
    expect(formatGrams(-0.01)).toBe('0 g');
  });
  it('signs changes with a real minus', () => {
    expect(formatDelta(-24)).toBe('−24 g');
    expect(formatDelta(500)).toBe('+500 g');
    expect(formatDelta(0.01)).toBe('±0 g');
  });
  it('colours and flags statuses', () => {
    expect(statusTone('consumed')).toBe('teal');
    expect(statusTone('needs_decision')).toBe('info');
    expect(statusTone('error')).toBe('red');
    expect(needsAction('unknown_tag')).toBe(true);
    expect(needsAction('consumed')).toBe(false);
  });
  it('measures latency only with a real clock', () => {
    const at = '2026-10-03T10:00:00.000Z';
    expect(latencyMs(at, Date.parse(at) + 1300, false)).toBe(1300);
    expect(latencyMs(at, Date.parse(at) + 1300, true)).toBeNull();
    expect(latencyMs(at, Date.parse(at) - 5, false)).toBeNull();
    expect(formatLatency(1300)).toBe('1.3 s');
    expect(formatLatency(850)).toBe('850 ms');
  });
  it('says online / Wi-Fi quality', () => {
    const now = Date.parse('2026-10-03T10:00:00Z');
    expect(deviceOnline('2026-10-03T09:59:20Z', now)).toBe(true);
    expect(deviceOnline('2026-10-03T09:57:00Z', now)).toBe(false);
    expect(deviceOnline(null, now)).toBe(false);
    expect(wifiQuality(-55)).toBe('good');
    expect(wifiQuality(-80)).toBe('weak');
  });
});

describe('protocol', () => {
  it('normalises tag UIDs like the database', () => {
    expect(normaliseUid('04:a1:b2:c3:d4:e5:f6')).toBe('04A1B2C3D4E5F6');
    expect(normaliseUid('04a1b2')).toBeNull();
  });
  it('accepts a real request and rejects out-of-range values', () => {
    const ok = SyncRequest.safeParse({
      v: 1, fw: '0.1.0', epoch: 7, boot: 3, up: 1000,
      events: [{ seq: 1, b: 3, t: 900, type: 'weigh', uid: '04A1B2C3D4E5F6', ndef: 'HL:LOC:7K2P9Q', gross_g: 1188 }],
    });
    expect(ok.success).toBe(true);
    expect(SyncRequest.safeParse({ v: 1, fw: '0.1.0', epoch: 7, boot: 3, up: 1000, events: [{ seq: -1, b: 3, t: 9, type: 'weigh', gross_g: 1 }] }).success).toBe(false);
    expect(SyncRequest.safeParse({ v: 2, fw: '0.1.0', epoch: 7, boot: 3, up: 1000 }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ seq: i, b: 1, t: 1, type: 'weigh', gross_g: 1 }));
    expect(SyncRequest.safeParse({ v: 1, fw: '0.1.0', epoch: 7, boot: 3, up: 1000, events: many }).success).toBe(false);
  });
});

function image(opts: { chip?: number; marker?: string; size?: number; partitionTable?: boolean; magic?: number } = {}): Uint8Array {
  const b = new Uint8Array(opts.size ?? 200_000);
  b[0] = opts.magic ?? 0xe9;
  b[12] = opts.chip ?? 9;
  if (opts.partitionTable) {
    b[0x8000] = 0xaa;
    b[0x8001] = 0x50;
  }
  const marker = opts.marker ?? 'GEDARA-FW:gedara-kitchen-scale:0.2.0:END';
  if (b.length > 0x1234 + marker.length) b.set([...marker].map((c) => c.charCodeAt(0)), 0x1234);
  return b;
}

describe('firmware file', () => {
  it('reads the version of a kitchen-scale image', () => {
    expect(checkFirmware(image())).toEqual({ ok: true, info: { version: '0.2.0', project: 'gedara-kitchen-scale', size: 200_000, chipId: 9 } });
  });
  it('refuses other files', () => {
    expect(checkFirmware(image({ magic: 0x50 }))).toEqual({ ok: false, problem: 'not_esp' });
    expect(checkFirmware(image({ chip: 0 }))).toEqual({ ok: false, problem: 'wrong_chip' });
    expect(checkFirmware(image({ partitionTable: true }))).toEqual({ ok: false, problem: 'full_flash' });
    expect(checkFirmware(image({ marker: 'nothing here' }))).toEqual({ ok: false, problem: 'not_gedara' });
    expect(checkFirmware(image({ marker: 'GEDARA-FW:other-thing:1.0.0:END' }))).toEqual({ ok: false, problem: 'wrong_project' });
    expect(checkFirmware(image({ size: 1000 }))).toEqual({ ok: false, problem: 'too_small' });
    expect(checkFirmware(image({ size: 4 * 1024 * 1024 }))).toEqual({ ok: false, problem: 'too_large' });
  });
  it('hashes and orders versions', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(compareVersions('0.2.0', '0.1.10')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0+b2')).toBe(0);
  });
});

class FakeReader extends EventTarget implements NdefReaderLike {
  written: string[] = [];
  private readonly serial: string;
  private readonly url: string | undefined;
  constructor(serial: string, url?: string) {
    super();
    this.serial = serial;
    this.url = url;
  }
  async scan() {
    setTimeout(() => {
      const e = new Event('reading') as Event & { serialNumber: string; message: unknown };
      e.serialNumber = this.serial;
      e.message = { records: this.url ? [{ recordType: 'url', data: new DataView(new TextEncoder().encode(this.url).buffer) }] : [] };
      this.dispatchEvent(e);
    }, 5);
  }
  async write(m: { records: { data: string }[] }) {
    this.written.push(m.records[0]!.data);
  }
}

describe('Web NFC', () => {
  it("reads a tag's UID and URL", async () => {
    const r = await readTag(new AbortController().signal, () => new FakeReader('04:a1:b2:c3:d4:e5:f6', 'https://gedara.vercel.app/s/HL:LOC:7K2P9Q'));
    expect(r).toEqual({ uid: '04A1B2C3D4E5F6', url: 'https://gedara.vercel.app/s/HL:LOC:7K2P9Q' });
  });
  it('writes the container URL and returns the UID', async () => {
    const fake = new FakeReader('04:aa:bb:cc:dd:ee:ff');
    const url = containerTagUrl('https://gedara.vercel.app/', 'HL:LOC:7K2P9Q');
    const r = await writeTag(url, new AbortController().signal, () => fake);
    expect(fake.written).toEqual(['https://gedara.vercel.app/s/HL:LOC:7K2P9Q']);
    expect(r.uid).toBe('04AABBCCDDEEFF');
  });
});
