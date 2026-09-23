import type { QrMatrix } from '../qr';

// NIIMBOT B1, 20 × 20 mm at 203 dpi ≈ 160 × 160 dots (MASTER_PLAN §7c, template `sq20-*`).
// Everything is composed in whole printer dots and saved as a real 1-bit PNG, so the NIIMBOT app
// (or later the Pi print service) prints it 1:1 without resampling.

export const SQ20_DOTS = 160;
export const SQ20_MODULE_DOTS = 5; // 21 modules × 5 = 105 dots ≈ 13.1 mm
const QR_TOP = 8;

/** 1 = black dot. Row-major, width × height. */
export interface Bitmap {
  width: number;
  height: number;
  bits: Uint8Array;
}

export function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, bits: new Uint8Array(width * height) };
}

export function blit(dst: Bitmap, src: Bitmap, x0: number, y0: number) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (!src.bits[y * src.width + x]) continue;
      const dx = x0 + x;
      const dy = y0 + y;
      if (dx >= 0 && dy >= 0 && dx < dst.width && dy < dst.height) dst.bits[dy * dst.width + dx] = 1;
    }
  }
}

/** QR centred at the top of a 160-dot label; `text` (already rasterised) centred below it. */
export function composeSq20(qr: QrMatrix, text: Bitmap | null): Bitmap {
  const out = blankBitmap(SQ20_DOTS, SQ20_DOTS);
  const qrDots = qr.size * SQ20_MODULE_DOTS;
  const x0 = Math.floor((SQ20_DOTS - qrDots) / 2);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.dark(r, c)) continue;
      for (let dy = 0; dy < SQ20_MODULE_DOTS; dy++) {
        const row = (QR_TOP + r * SQ20_MODULE_DOTS + dy) * SQ20_DOTS;
        out.bits.fill(1, row + x0 + c * SQ20_MODULE_DOTS, row + x0 + (c + 1) * SQ20_MODULE_DOTS);
      }
    }
  }
  if (text) {
    const top = QR_TOP + qrDots + Math.max(0, Math.floor((SQ20_DOTS - QR_TOP - qrDots - text.height) / 2));
    blit(out, text, Math.floor((SQ20_DOTS - text.width) / 2), top);
  }
  return out;
}

/** Space left under the QR for the text line. */
export function sq20TextArea(qrSize = 21) {
  return { width: SQ20_DOTS - 8, height: SQ20_DOTS - QR_TOP - qrSize * SQ20_MODULE_DOTS - 6 };
}

// ── 1-bit PNG encoder (grayscale, bit depth 1, with pHYs = 203 dpi) ───────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng1bit(bm: Bitmap, dpi = 203): Promise<Uint8Array> {
  const rowBytes = Math.ceil(bm.width / 8);
  const raw = new Uint8Array((rowBytes + 1) * bm.height);
  for (let y = 0; y < bm.height; y++) {
    const base = y * (rowBytes + 1); // filter byte 0 (None)
    for (let x = 0; x < bm.width; x++) {
      // Grayscale 1-bit: 1 = white. Our 1 = black, so invert.
      if (!bm.bits[y * bm.width + x]) raw[base + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
    // Pad bits beyond width stay 0; harmless.
  }
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, bm.width);
  hv.setUint32(4, bm.height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  const ppm = Math.round(dpi / 0.0254);
  pv.setUint32(0, ppm);
  pv.setUint32(4, ppm);
  phys[8] = 1; // metre
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Browser only: rasterise one text line to a 1-bit bitmap by thresholding (no anti-aliasing kept). */
export function rasterizeText(text: string, maxWidth: number, maxHeight: number, font = 'Space Grotesk'): Bitmap {
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = maxHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return blankBitmap(1, 1);
  let size = maxHeight;
  do {
    ctx.font = `700 ${size}px "${font}", system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size--;
  } while (size > 10);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, maxWidth, maxHeight);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, maxWidth / 2, maxHeight / 2 + 1, maxWidth);
  const { data } = ctx.getImageData(0, 0, maxWidth, maxHeight);
  const bm = blankBitmap(maxWidth, maxHeight);
  for (let i = 0; i < bm.bits.length; i++) bm.bits[i] = data[i * 4]! < 128 ? 1 : 0;
  return bm;
}
