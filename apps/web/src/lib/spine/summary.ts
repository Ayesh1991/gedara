// "Rs 4,620 · 8 to pantry (2 new) · 3 ticked": what one confirm will do.
import type { LineRoute } from './route';

export interface OpenItem {
  id: string | null;
  product_id: string | null;
}

export interface BillSummary {
  lines: number;
  stock: number;
  asset: number;
  expense: number;
  newProducts: number;
  ticked: number;
  /** Open list items the stocked products will tick. */
  tickedItemIds: string[];
}

export function billSummary(
  routes: LineRoute[],
  openItems: OpenItem[],
  tickFreeIds: Iterable<string>,
  createdProductIds: Set<string>,
): BillSummary {
  const stocked = new Set(routes.filter((r) => r.destiny === 'stock' && r.productId).map((r) => r.productId!));
  const byProduct = openItems.filter((i) => i.id && i.product_id && stocked.has(i.product_id)).map((i) => i.id!);
  const free = new Set(tickFreeIds);
  for (const id of byProduct) free.delete(id);
  return {
    lines: routes.length,
    stock: routes.filter((r) => r.destiny === 'stock').length,
    asset: routes.filter((r) => r.destiny === 'asset').length,
    expense: routes.filter((r) => r.destiny === 'expense').length,
    newProducts: [...stocked].filter((id) => createdProductIds.has(id)).length,
    ticked: byProduct.length + free.size,
    tickedItemIds: byProduct,
  };
}
