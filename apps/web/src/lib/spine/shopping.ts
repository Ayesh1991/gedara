// Shopping list presentation: what's still to buy (below-minimum items first, then by name) and
// what was bought (latest first). "Not now" items are hidden.
export interface ListRow {
  id: string | null;
  product_name: string | null;
  free_text: string | null;
  source: string | null;
  done: boolean | null;
  dismissed: boolean | null;
  done_at: string | null;
  created_at: string | null;
}

export function itemName(i: Pick<ListRow, 'product_name' | 'free_text'>): string {
  return i.product_name ?? i.free_text ?? '';
}

export function splitList<T extends ListRow>(items: T[]): { open: T[]; done: T[] } {
  const open = items
    .filter((i) => !i.done && !i.dismissed)
    .sort(
      (a, b) =>
        Number(b.source === 'below_min') - Number(a.source === 'below_min') ||
        itemName(a).localeCompare(itemName(b), undefined, { sensitivity: 'base' }),
    );
  const done = items.filter((i) => i.done).sort((a, b) => ((a.done_at ?? '') < (b.done_at ?? '') ? 1 : -1));
  return { open, done };
}
