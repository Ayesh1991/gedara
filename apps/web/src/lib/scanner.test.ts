import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { parseScan } from './codes';
import { hybridDecoder, type Decoder } from './scanner';

// Phase 7d: Android's built-in detector missed a printed A4 label that zxing reads at once.
describe('camera decoding', () => {
  it('zxing reads the A4 "Kitchen" label as the phone camera saw it', async () => {
    const photo = readFileSync(new URL('./__fixtures__/a4-kitchen-label.jpg', import.meta.url));
    const found = await readBarcodes(new Blob([photo]), { formats: ['QRCode'], tryHarder: true });
    const text = found.find((r) => r.isValid)?.text ?? '';
    expect(parseScan(text)).toEqual({ kind: 'loc', code: 'HL:LOC:4BGBS8' });
  });

  it('the hybrid decoder asks zxing when the native detector keeps missing', async () => {
    const video = {} as HTMLVideoElement;
    const native: Decoder = { engine: 'native', decode: async () => null };
    let zxingCalls = 0;
    let loads = 0;
    const zxing: Decoder = {
      engine: 'zxing',
      decode: async () => {
        zxingCalls += 1;
        return 'https://gedara.vercel.app/s/HL:LOC:4BGBS8';
      },
    };
    const d = hybridDecoder(native, async () => {
      loads += 1;
      return zxing;
    });
    expect(await d.decode(video)).toBeNull(); // 1st miss: native only
    expect(await d.decode(video)).toBe('https://gedara.vercel.app/s/HL:LOC:4BGBS8'); // 2nd: zxing too
    expect(await d.decode(video)).toBeNull();
    expect(await d.decode(video)).not.toBeNull();
    expect(zxingCalls).toBe(2);
    expect(loads).toBe(1); // loaded once, on first need
  });

  it('a native hit is used as is, and zxing is never loaded', async () => {
    let loads = 0;
    const d = hybridDecoder({ engine: 'native', decode: async () => '4792236001130' }, async () => {
      loads += 1;
      throw new Error('should not load');
    });
    for (let i = 0; i < 4; i++) expect(await d.decode({} as HTMLVideoElement)).toBe('4792236001130');
    expect(loads).toBe(0);
  });
});
