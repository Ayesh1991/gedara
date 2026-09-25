// Bill line → product (MASTER_PLAN §4 row 1: "matched barcode → alias → trigram name").
// Runs in the web app like SMS matching (decisions 2026-09-24); the database only stores what was
// learned (`product_alias`). Tiers:
//   barcode printed on the bill           → sure  (teal)
//   a learned name (exact, normalised)    → sure  (can also say "not stock")
//   trigram name similarity ≥ CHECK_AT    → check (pre-selected, amber: "is this right?")
//   ≥ MAYBE_AT                            → maybe (only suggested)
// A name match is downgraded to "maybe" when it's ambiguous (two products almost equally close) or
// when the product sits in a different top-level category than the line.
import { billNameNorm } from './normalise';

export type Destiny = 'stock' | 'asset' | 'expense';
export type Confidence = 'sure' | 'check' | 'maybe' | 'none';

export const CHECK_AT = 0.55;
export const MAYBE_AT = 0.3;
const AMBIGUOUS_GAP = 0.05;

export interface MatchProduct {
  id: string;
  name: string;
  name_si: string | null;
  archived: boolean;
  category_id: string | null;
}
export interface AliasRow {
  alias_norm: string;
  product_id: string | null;
  destiny: string;
}
export interface BarcodeRow {
  barcode: string;
  product_id: string;
}

export interface Suggestion {
  productId: string;
  score: number;
}
export interface Match {
  productId: string | null;
  /** Only set by a learned name (it may say 'expense' / 'asset'). */
  destiny: Destiny | null;
  via: 'barcode' | 'alias' | 'name' | null;
  score: number;
  confidence: Confidence;
  suggestions: Suggestion[];
}

const NONE: Match = { productId: null, destiny: null, via: null, score: 0, confidence: 'none', suggestions: [] };

/** pg_trgm-style trigrams: each word padded with two spaces before and one after. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of billNameNorm(s).split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!w) continue;
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n;
}

/** |A ∩ B| / |A ∪ B| (pg_trgm similarity). */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const i = overlap(a, b);
  return i / (a.size + b.size - i);
}

/** How much of `needle` (a product name) appears in `hay` (a bill line), 0..1. */
export function containment(needle: Set<string>, hay: Set<string>): number {
  return needle.size ? overlap(needle, hay) / needle.size : 0;
}

/**
 * Bill lines name more than the product ("ANCHOR HOT CHOCOLATE 400G" for "Hot chocolate"), so a
 * product name found inside the line counts too — more the more of the line it explains, so
 * "Sugar 1kg pack" prefers the product "Sugar 1kg" over plain "Sugar".
 */
export function nameScore(names: Set<string>[], line: Set<string>): number {
  let best = 0;
  for (const n of names) {
    const covered = line.size ? overlap(n, line) / line.size : 0;
    best = Math.max(best, similarity(n, line), 0.9 * containment(n, line) * (0.5 + 0.5 * covered));
  }
  return Math.round(best * 1000) / 1000;
}

export interface Matcher {
  match(line: { raw_name: string; barcode?: string | null; categoryTop?: string | null }): Match;
}

export function buildMatcher(opts: {
  products: MatchProduct[];
  aliases: AliasRow[];
  barcodes: BarcodeRow[];
  /** Top-level category of a category id (to spot "Salted peanuts" ≠ the product "Salt"). */
  topOf?: (categoryId: string | null) => string | null;
}): Matcher {
  const active = opts.products.filter((p) => !p.archived);
  const activeIds = new Set(active.map((p) => p.id));
  const byAlias = new Map(opts.aliases.map((a) => [a.alias_norm, a]));
  const byBarcode = new Map(opts.barcodes.map((b) => [b.barcode.trim(), b.product_id]));
  // Every name a product is known by: its name, Sinhala name, and the bill names learned for it.
  const names = new Map<string, Set<string>[]>(active.map((p) => [p.id, [trigrams(p.name), ...(p.name_si ? [trigrams(p.name_si)] : [])]]));
  for (const a of opts.aliases) if (a.product_id && names.has(a.product_id)) names.get(a.product_id)!.push(trigrams(a.alias_norm));
  const topOfProduct = new Map(active.map((p) => [p.id, opts.topOf?.(p.category_id) ?? null]));

  return {
    match({ raw_name, barcode, categoryTop }) {
      const code = barcode?.trim();
      if (code && byBarcode.has(code) && activeIds.has(byBarcode.get(code)!)) {
        return { ...NONE, productId: byBarcode.get(code)!, destiny: 'stock', via: 'barcode', score: 1, confidence: 'sure' };
      }

      const alias = byAlias.get(billNameNorm(raw_name));
      if (alias) {
        if (alias.destiny !== 'stock') {
          return { ...NONE, destiny: alias.destiny as Destiny, via: 'alias', score: 1, confidence: 'sure' };
        }
        if (alias.product_id && activeIds.has(alias.product_id)) {
          return { ...NONE, productId: alias.product_id, destiny: 'stock', via: 'alias', score: 1, confidence: 'sure' };
        }
      }

      const line = trigrams(raw_name);
      const scored = [...names]
        .map(([productId, ns]) => ({ productId, score: nameScore(ns, line) }))
        .filter((s) => s.score >= 0.2)
        .sort((a, b) => b.score - a.score);
      const suggestions = scored.slice(0, 3);
      const best = scored[0];
      if (!best || best.score < MAYBE_AT) return { ...NONE, suggestions };

      let confidence: Confidence = best.score >= CHECK_AT ? 'check' : 'maybe';
      const second = scored[1];
      if (confidence === 'check' && second && best.score - second.score < AMBIGUOUS_GAP) confidence = 'maybe';
      const productTop = topOfProduct.get(best.productId) ?? null;
      if (confidence === 'check' && categoryTop && productTop && categoryTop !== productTop) confidence = 'maybe';
      return { productId: best.productId, destiny: null, via: 'name', score: best.score, confidence, suggestions };
    },
  };
}
