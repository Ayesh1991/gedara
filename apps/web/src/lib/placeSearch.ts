// Search on Places (Phase 12): find a place by its name or path, or by what is kept in it (things
// and pantry items). Pure: it only filters rows the app has already been given. Valuable places and
// what is inside them never reach a non-owner's app at all (RLS, migrations 98 and 103), so they
// cannot show up here for anyone but the owner.

export interface SearchPlace {
  id: string;
  name: string;
  path: string;
}
export interface SearchThing {
  id: string;
  name: string;
  location_id: string | null;
  /** Other words it can be found by: A-number, maker, model, serial. */
  words?: Array<string | null | undefined>;
}
export interface SearchLot {
  product_id: string;
  location_id: string | null;
}
export interface SearchProduct {
  id: string;
  name: string;
  name_si?: string | null;
}

export interface KeptItem {
  kind: 'thing' | 'product';
  id: string;
  name: string;
}
export interface KeptHit<P extends SearchPlace> {
  place: P;
  items: KeptItem[];
}
export interface PlaceSearchResult<P extends SearchPlace> {
  /** Places whose own name or path matches. */
  places: P[];
  /** Places found by something kept in them. */
  kept: Array<KeptHit<P>>;
}

/** Lower case, accents and width folded, spaces collapsed (Sinhala is left as it is). */
export function fold(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every word of the search must be somewhere in the text. */
export function matchesAll(text: string, words: string[]): boolean {
  return words.every((w) => text.includes(w));
}

export function searchPlaces<P extends SearchPlace>(
  query: string,
  places: readonly P[],
  things: readonly SearchThing[],
  lots: readonly SearchLot[],
  products: readonly SearchProduct[],
): PlaceSearchResult<P> {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return { places: [], kept: [] };
  const byPath = (a: P, b: P) => a.path.localeCompare(b.path, undefined, { numeric: true });
  const byId = new Map(places.map((p) => [p.id, p]));

  const named = places.filter((p) => matchesAll(fold(`${p.name} ${p.path}`), words)).sort(byPath);

  const kept = new Map<string, KeptItem[]>();
  const add = (placeId: string | null, item: KeptItem) => {
    if (!placeId || !byId.has(placeId)) return; // no place, or a place this person is not shown
    const list = kept.get(placeId) ?? [];
    if (!list.some((i) => i.kind === item.kind && i.id === item.id)) list.push(item);
    kept.set(placeId, list);
  };
  for (const th of things) {
    if (matchesAll(fold([th.name, ...(th.words ?? [])].filter(Boolean).join(' ')), words)) {
      add(th.location_id, { kind: 'thing', id: th.id, name: th.name });
    }
  }
  const hit = new Map(
    products.filter((p) => matchesAll(fold(`${p.name} ${p.name_si ?? ''}`), words)).map((p) => [p.id, p]),
  );
  for (const lot of lots) {
    const p = hit.get(lot.product_id);
    if (p) add(lot.location_id, { kind: 'product', id: p.id, name: p.name });
  }
  return {
    places: named,
    kept: [...kept]
      .map(([id, items]) => ({ place: byId.get(id)!, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => byPath(a.place, b.place)),
  };
}
