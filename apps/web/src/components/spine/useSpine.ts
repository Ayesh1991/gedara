import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { usePantry } from '@/components/pantry/bits';
import { topOf, type CategoryRow } from '@/lib/money/categoriesMap';
import type { Product } from '@/lib/pantry/queries';
import { buildMatcher } from '@/lib/spine/match';
import { aliasesQuery } from '@/lib/spine/queries';
import { initialRoute, isDestiny, type LineRoute, type RouteLine } from '@/lib/spine/route';
import type { Destiny } from '@/lib/spine/match';

/** A bill line as the router sees it (from an import preview or a saved transaction). */
export interface RouterLine extends RouteLine {
  key: string;
  category_id: string | null;
  barcode?: string | null;
}

/** Pantry + learned names: everything routing needs. */
export function useSpineData(householdId: string) {
  const pantry = usePantry(householdId);
  const aliases = useQuery(aliasesQuery(householdId));
  return {
    ...pantry,
    householdId,
    aliases,
    ready: pantry.ready && pantry.categories.isSuccess && aliases.isSuccess && pantry.barcodes.isSuccess,
  };
}
export type SpineData = ReturnType<typeof useSpineData>;

export function categoryDestiny(categories: CategoryRow[], id: string | null): Destiny {
  const d = categories.find((x) => x.id === id)?.default_destiny;
  return isDestiny(d) ? d : 'expense';
}

/** The proposal for every line (recomputed when products or learned names change). */
export function useProposals(lines: RouterLine[], data: SpineData): Map<string, LineRoute> {
  const products = data.products.data;
  const categories = data.categories.data;
  const aliases = data.aliases.data;
  const barcodes = data.barcodes.data;
  return useMemo(() => {
    const out = new Map<string, LineRoute>();
    if (!products || !categories || !aliases || !barcodes) return out;
    const matcher = buildMatcher({
      products,
      aliases,
      barcodes,
      topOf: (id) => topOf(categories, id)?.id ?? null,
    });
    const byId = new Map<string, Product>(products.map((p) => [p.id, p]));
    for (const l of lines) {
      const m = matcher.match({ raw_name: l.raw_name, barcode: l.barcode, categoryTop: topOf(categories, l.category_id)?.id ?? null });
      out.set(l.key, initialRoute(l, m, categoryDestiny(categories, l.category_id), byId));
    }
    return out;
  }, [lines, products, categories, aliases, barcodes]);
}
