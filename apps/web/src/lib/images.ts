// Photo pipeline (rule 9): decode in the browser, resize to 1600 px + a 320 px thumbnail, encode
// WebP, then upload. The file's type is decided from its magic bytes, never its name (rule 6).

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/gif';

export const FULL_PX = 1600;
export const THUMB_PX = 320;
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export function sniffImage(head: Uint8Array): ImageMime | null {
  const b = head;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(ascii(8, 12))) {
    return 'image/heic';
  }
  return null;
}

/** Longest side ≤ max, never upscaled, whole pixels. */
export function fitWithin(w: number, h: number, max: number) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export class ImageError extends Error {
  constructor(public reason: 'unsupported' | 'tooLarge' | 'decode') {
    super(reason);
  }
}

export interface CompressedPhoto {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

function draw(bitmap: ImageBitmap, max: number) {
  const { w, h } = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('decode');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

async function toWebp(max: number, bitmap: ImageBitmap, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  const { canvas, ctx, w, h } = draw(bitmap, max);
  const native = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (native?.type === 'image/webp') return { blob: native, w, h };
  // Safari can't encode WebP from a canvas (it silently returns PNG): use the WASM encoder.
  const { default: encode } = await import('@jsquash/webp/encode');
  const buf = await encode(ctx.getImageData(0, 0, w, h), { quality: Math.round(quality * 100) });
  return { blob: new Blob([buf], { type: 'image/webp' }), w, h };
}

export async function compressPhoto(file: Blob): Promise<CompressedPhoto> {
  if (file.size > MAX_INPUT_BYTES) throw new ImageError('tooLarge');
  const mime = sniffImage(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (!mime) throw new ImageError('unsupported');
  let bitmap: ImageBitmap;
  try {
    // EXIF orientation is applied, so phone photos come out upright.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // HEIC decodes only where the OS can (Safari). Elsewhere, ask for a JPEG.
    throw new ImageError(mime === 'image/heic' ? 'unsupported' : 'decode');
  }
  try {
    const full = await toWebp(FULL_PX, bitmap, 0.8);
    const thumb = await toWebp(THUMB_PX, bitmap, 0.72);
    return { full: full.blob, thumb: thumb.blob, width: full.w, height: full.h };
  } finally {
    bitmap.close();
  }
}
