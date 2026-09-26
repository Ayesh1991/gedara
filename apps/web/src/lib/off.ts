// Open Food Facts (MASTER_PLAN §7 item 3): an unknown barcode's name, brand and pack size, to prefill
// the new-product form. Coverage of Sri Lankan brands is patchy, so this only ever helps: the
// barcode → product link the household makes once stays the main path. The reply is validated with
// Zod (rule 6); nothing from it is saved without the person pressing Save.
import { z } from 'zod';

const TIMEOUT_MS = 4000;
const FIELDS = 'product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,image_front_small_url,categories_tags';
const IMAGE_HOSTS = /^https:\/\/(images|static)\.openfoodfacts\.org\//;

const Reply = z.object({
  status: z.number(),
  product: z
    .object({
      product_name: z.string().max(300).optional(),
      product_name_en: z.string().max(300).optional(),
      brands: z.string().max(300).optional(),
      quantity: z.string().max(80).optional(),
      product_quantity: z.union([z.number(), z.string().max(20)]).optional(),
      product_quantity_unit: z.string().max(10).optional(),
      image_front_small_url: z.string().max(500).optional(),
      categories_tags: z.array(z.string().max(160)).max(200).optional(),
    })
    .optional(),
});

export interface OffInfo {
  name: string;
  brand: string | null;
  /** Pack size in a base unit: 400 g, 1000 ml, 6 pcs. */
  pack: { qty: number; unit: 'g' | 'ml' | 'pcs' } | null;
  imageUrl: string | null;
  categories: string[];
}

/** "400 g", "1 kg", "500ml", "1.5 L", "6 x 200 ml", "12 pcs" → the whole pack in g / ml / pcs. */
export function parseOffQuantity(q: string | undefined | null): OffInfo['pack'] {
  if (!q) return null;
  const t = q.toLowerCase().replace(',', '.');
  const m = /(?:(\d+(?:\.\d+)?)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|g|gr|mg|l|ltr|litre|liter|ml|cl|pcs|pieces|pc|units?)\b/.exec(t);
  if (!m) return null;
  const times = m[1] ? Number(m[1]) : 1;
  const n = Number(m[2]) * times;
  const u = m[3]!;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (u === 'kg') return { qty: round(n * 1000), unit: 'g' };
  if (u === 'g' || u === 'gr') return { qty: round(n), unit: 'g' };
  if (u === 'mg') return { qty: round(n / 1000), unit: 'g' };
  if (u === 'l' || u === 'ltr' || u === 'litre' || u === 'liter') return { qty: round(n * 1000), unit: 'ml' };
  if (u === 'cl') return { qty: round(n * 10), unit: 'ml' };
  if (u === 'ml') return { qty: round(n), unit: 'ml' };
  return { qty: round(n), unit: 'pcs' };
}

export function toOffInfo(raw: unknown): OffInfo | null {
  const r = Reply.safeParse(raw);
  if (!r.success || r.data.status !== 1 || !r.data.product) return null;
  const p = r.data.product;
  const base = (p.product_name || p.product_name_en || '').trim();
  const brand = (p.brands ?? '').split(',')[0]?.trim() || null;
  if (!base && !brand) return null;
  const name = (brand && !base.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${base}` : base || brand || '').trim().slice(0, 80);
  const qtyText = p.quantity ?? (p.product_quantity ? `${p.product_quantity} ${p.product_quantity_unit ?? 'g'}` : null);
  const img = p.image_front_small_url && IMAGE_HOSTS.test(p.image_front_small_url) ? p.image_front_small_url : null;
  return { name, brand, pack: parseOffQuantity(qtyText), imageUrl: img, categories: p.categories_tags ?? [] };
}

/** Look a barcode up (online only; null when unknown, offline or slow). */
export async function lookupOff(ean: string): Promise<OffInfo | null> {
  if (!/^\d{8,14}$/.test(ean) || (typeof navigator !== 'undefined' && !navigator.onLine)) return null;
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=${FIELDS}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return null;
    return toOffInfo(await res.json());
  } catch {
    return null;
  }
}

/** The front photo as a File for the normal photo pipeline (WebP 1600 + thumb, rule 9). */
export async function offPhoto(url: string): Promise<File | null> {
  if (!IMAGE_HOSTS.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const blob = await res.blob();
    return blob.size > 0 && blob.size < 5_000_000 ? new File([blob], 'off-front', { type }) : null;
  } catch {
    return null;
  }
}
