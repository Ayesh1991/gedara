// The aurora behind the cover takes its colours from the cover itself (Phase 7h). Pixels are
// grouped into coarse colour boxes, boxes are scored by how many pixels they hold and how vivid they
// are (grey, near-black and near-white count little), and the two or three best that differ enough
// are kept. The glow is drawn under Aurora's light text, so every colour is clamped to a mid
// brightness: never so light that white text on top would be hard to read.
export type Rgb = [number, number, number];

const BITS = 4; // 16 levels per channel → 4096 boxes
const SHIFT = 8 - BITS;

function lightness([r, g, b]: Rgb): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

function saturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 510;
  return (max - min) / 255 / (1 - Math.abs(2 * l - 1));
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Scale a colour so its lightness lies between 0.28 and 0.55 (glow under white text). */
export function forGlow(c: Rgb): Rgb {
  const l = lightness(c);
  const target = Math.min(0.55, Math.max(0.28, l));
  if (l === 0) return [Math.round(target * 255), Math.round(target * 255), Math.round(target * 255)];
  const k = target / l;
  return c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))) as Rgb;
}

/** Up to `count` distinct, vivid colours of an RGBA pixel buffer (every 4th byte is alpha). */
export function dominantColours(pixels: ArrayLike<number>, count = 3): Rgb[] {
  const boxes = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 255) < 128) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const key = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const box = boxes.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    box.n++;
    box.r += r;
    box.g += g;
    box.b += b;
    boxes.set(key, box);
  }
  const scored = [...boxes.values()]
    .map((x) => {
      const c: Rgb = [x.r / x.n, x.g / x.n, x.b / x.n];
      const l = lightness(c);
      const vivid = 0.15 + saturation(c);
      const midtone = l < 0.08 || l > 0.94 ? 0.1 : 1;
      return { c, score: x.n * vivid * midtone };
    })
    .sort((a, b) => b.score - a.score);
  const out: Rgb[] = [];
  for (const s of scored) {
    if (out.every((o) => distance(o, s.c) > 60)) out.push(s.c.map(Math.round) as Rgb);
    if (out.length === count) break;
  }
  return out;
}

export const css = ([r, g, b]: Rgb, alpha = 1) => (alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`);

/** Colours of an image already loaded in the page (CORS-clean: signed Storage links are). */
export function coloursOf(img: HTMLImageElement, count = 3): Rgb[] {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, 48, 48);
  try {
    return dominantColours(ctx.getImageData(0, 0, 48, 48).data, count).map(forGlow);
  } catch {
    return []; // a tainted canvas: fall back to the theme's aurora
  }
}
