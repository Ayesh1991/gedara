import { describe, expect, it } from 'vitest';
import { fitWithin, sniffImage } from './images';

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('sniffImage (magic bytes, not file names)', () => {
  it('detects the formats phones produce', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(bytes([0, 0, 0, 0x18], 'ftypheic'))).toBe('image/heic');
  });

  it('rejects everything else, whatever it is called', () => {
    expect(sniffImage(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffImage(bytes('<svg xmlns'))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe('fitWithin', () => {
  it('scales the long side down and never up', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(3024, 4032, 320)).toEqual({ w: 240, h: 320 });
    expect(fitWithin(800, 600, 1600)).toEqual({ w: 800, h: 600 });
  });
});
