// Which product is this barcode? (bin scanner, link sheet). Products that came from a bill have no
// barcode yet, so those come first. With a name from Open Food Facts the products are ranked by the
// words they share with it; without one (common for Sri Lankan brands) the newest products with no
// barcode that are in stock are offered: what the last bills brought in.

export interface SuggestProduct {
  id: string;
  name: string;
  archived: boolean;
  created_at: string;
  stock: { qty: number };
}

export interface Suggestion {
  id: string;
  name: string;
  hasBarcode: boolean;
  inStock: number;
}

// Pack sizes and filler words say nothing about which product it is.
const NOISE = new Set(['g', 'kg', 'mg', 'ml', 'l', 'ltr', 'pcs', 'pc', 'pack', 'the', 'and', 'with', 'of']);

export function nameWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().normalize('NFKD').split(/[^a-z඀-෿]+/)) {
    if (w.length >= 2 && !NOISE.has(w)) out.add(w);
  }
  return out;
}

function score(product: Set<string>, off: Set<string>): number {
  let n = 0;
  for (const w of off) {
    if (product.has(w)) n += 1;
    // "yoghurt" vs "yogurt", "biscuits" vs "biscuit": same first 3 letters, about the same length.
    else if (w.length >= 4 && [...product].some((p) => p.length >= 4 && p.slice(0, 3) === w.slice(0, 3) && Math.abs(p.length - w.length) <= 2)) n += 0.5;
  }
  return n;
}

export function suggestProducts(
  products: readonly SuggestProduct[],
  barcodedIds: ReadonlySet<string>,
  offName: string | null | undefined,
  limit = 4,
): Suggestion[] {
  const live = products.filter((p) => !p.archived);
  const toSuggestion = (p: SuggestProduct): Suggestion => ({
    id: p.id,
    name: p.name,
    hasBarcode: barcodedIds.has(p.id),
    inStock: p.stock.qty,
  });
  const off = nameWords(offName ?? '');

  if (off.size > 0) {
    const ranked = live
      .map((p) => {
        const s = score(nameWords(p.name), off);
        // Same match: no barcode yet first, then in stock.
        const bonus = (barcodedIds.has(p.id) ? 0 : 0.3) + (p.stock.qty > 0 ? 0.1 : 0);
        return { p, s, total: s + bonus };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.total - a.total || a.p.name.localeCompare(b.p.name));
    if (ranked.length > 0) return ranked.slice(0, limit).map((x) => toSuggestion(x.p));
  }

  return live
    .filter((p) => !barcodedIds.has(p.id) && p.stock.qty > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(toSuggestion);
}

/** The link only changes the barcode: a Check scan and no other scan of this code waiting. */
export function linkOnly(mode: string | null | undefined, waiting: number): boolean {
  return mode === 'check' && waiting <= 1;
}

/**
 * Open Food Facts' pack size as "one scan means", when it measures the same thing as the product
 * (400 g for a product kept in g or kg). Products counted in pieces keep 1: "6 pcs" on a box of
 * biscuits says nothing about how the household counts them.
 */
export function packFromOff(
  pack: { qty: number; unit: 'g' | 'ml' | 'pcs' } | null | undefined,
  stockDimension: string | null | undefined,
): { qty: number; unitCode: 'g' | 'ml' } | null {
  if (!pack || !(pack.qty > 0) || pack.unit === 'pcs') return null;
  const dim = pack.unit === 'g' ? 'mass' : 'volume';
  return dim === stockDimension ? { qty: pack.qty, unitCode: pack.unit } : null;
}
