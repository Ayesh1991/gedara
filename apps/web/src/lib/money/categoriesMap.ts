// Mapping scanner / Sheet category names onto the household's categories. The rules are ported
// from ledger v7 (`CAT_ALIAS`, `guessCat`, `guessSub`, `NAME_TO_CAT`) so imports land where the old
// ledger put them.

export const TOP_KEYS = [
  'grocery', 'consumable', 'nonconsumable', 'energy', 'water', 'services', 'dining', 'transport', 'other', 'income',
] as const;
export type TopKey = (typeof TOP_KEYS)[number];

const CAT_ALIAS: Record<string, TopKey> = {
  grocery: 'grocery', groceries: 'grocery', consumable: 'consumable', consumables: 'consumable',
  'non-consumable': 'nonconsumable', 'non consumable': 'nonconsumable', nonconsumable: 'nonconsumable',
  'non-consumables': 'nonconsumable',
  energy: 'energy', fuel: 'energy', water: 'water', service: 'services', services: 'services',
  dining: 'dining', 'dining out': 'dining', restaurant: 'dining', food: 'dining', transport: 'transport',
  other: 'other', income: 'income',
};

/** The Sheet stores display names ("Dining out"); ledger v7 `NAME_TO_CAT`. */
export const SHEET_NAME_TO_KEY: Record<string, TopKey> = {
  Grocery: 'grocery', Consumables: 'consumable', 'Non-consumables': 'nonconsumable', Energy: 'energy',
  Water: 'water', Services: 'services', 'Dining out': 'dining', Transport: 'transport', Other: 'other',
};

const CAT_RULES: Array<[RegExp, TopKey]> = [
  [/rice|sugar|salt|flour|dhal|dal|oil|milk|egg|bread|tea|coffee|biscuit|vegetable|fruit|chicken|fish|meat|prawn|spice|onion|potato|samba|keeri/, 'grocery'],
  [/soap|shampoo|toothpaste|detergent|tissue|sanitary|diaper|panadol|medicine|garbage bag|cleaner/, 'consumable'],
  [/dress|shirt|trouser|saree|shoe|slipper|phone|tv|fridge|fan|furniture|plate|pan/, 'nonconsumable'],
  [/petrol|diesel|gas|electricit|kwh|fuel/, 'energy'],
  [/water/, 'water'],
  [/insurance|mobile|reload|internet|dialog|slt|mobitel|hutch|airtel|subscription|netflix/, 'services'],
  [/restaurant|kottu|pizza|burger|kfc|mcdonald|cafe|hotel food/, 'dining'],
  [/bus|train|taxi|pickme|uber|tyre|service charge/, 'transport'],
];

const SUB_RULES: Array<[RegExp, string]> = [
  [/rice|samba|keeri|nadu|ponni/, 'Rice'], [/sugar/, 'Sugar'], [/salt|pepper|chili|curry powder|spice/, 'Salt & spices'],
  [/vegetable|onion|potato|carrot|bean|leek|tomato/, 'Vegetables'], [/fruit|banana|apple|mango|papaya/, 'Fruits'],
  [/chicken|beef|mutton|pork|sausage/, 'Meat'], [/fish|prawn|cuttle|sprats|tuna/, 'Fish & seafood'],
  [/milk|cheese|yog|curd|butter/, 'Dairy & milk'], [/bread|bun|cake|bakery/, 'Bread & bakery'],
  [/petrol/, 'Petrol'], [/diesel/, 'Diesel'], [/gas/, 'LP Gas'], [/electric|kwh/, 'Electricity'],
  [/dress|frock|shirt|saree|trouser|skirt/, 'Clothing'], [/shoe|slipper|sandal/, 'Footwear'],
  [/garbage|detergent|cleaner|soap bar/, 'Cleaning & detergents'],
];

export function guessTopKey(item: string | null | undefined, given?: string | null): TopKey {
  const alias = given ? CAT_ALIAS[String(given).toLowerCase().trim()] : undefined;
  if (alias) return alias;
  const n = (item || '').toLowerCase();
  for (const [re, key] of CAT_RULES) if (re.test(n)) return key;
  return 'grocery';
}

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  key: string | null;
  name: string;
  kind: string;
  sort: number;
  archived: boolean;
  icon?: string | null;
  color?: string | null;
  default_destiny?: string;
}

export interface CategoryPick {
  categoryId: string | null;
  /** false when the scanner's sub-category wasn't found and a fallback was used. */
  exact: boolean;
}

/** Sub-categories of a top level, in display order. */
export function subsOf(categories: CategoryRow[], topId: string): CategoryRow[] {
  return categories.filter((c) => c.parent_id === topId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/**
 * Top key + (scanner or Sheet) sub-category name → category id. Unknown subs follow ledger v7
 * `guessSub`: a sub whose first word appears in the item name, then keyword rules, then the
 * top level's last ("Other …") sub.
 */
export function pickCategory(
  categories: CategoryRow[],
  key: TopKey,
  item: string | null | undefined,
  givenSub?: string | null,
): CategoryPick {
  const top = categories.find((c) => c.parent_id === null && c.key === key);
  if (!top) return { categoryId: null, exact: false };
  const subs = subsOf(categories, top.id);
  const byName = (name: string) => subs.find((s) => s.name.toLowerCase() === name.toLowerCase());

  if (givenSub) {
    const hit = byName(givenSub.trim());
    if (hit) return { categoryId: hit.id, exact: true };
  }
  const n = (item || '').toLowerCase();
  const firstWord = subs.find((s) => {
    const w = s.name.toLowerCase().split(' ')[0]!;
    return w !== 'other' && n.includes(w);
  });
  if (firstWord) return { categoryId: firstWord.id, exact: !givenSub };
  for (const [re, name] of SUB_RULES) {
    const hit = re.test(n) ? byName(name) : undefined;
    if (hit) return { categoryId: hit.id, exact: !givenSub };
  }
  const fallback = subs.at(-1) ?? top;
  return { categoryId: fallback.id, exact: !givenSub };
}

/** "Grocery › Rice" */
export function categoryLabel(categories: CategoryRow[], id: string | null | undefined): string {
  const c = categories.find((x) => x.id === id);
  if (!c) return '';
  const parent = c.parent_id ? categories.find((x) => x.id === c.parent_id) : undefined;
  return parent ? `${parent.name} › ${c.name}` : c.name;
}

/** Top-level key for a category id (itself or its parent). */
export function topOf(categories: CategoryRow[], id: string | null | undefined): CategoryRow | undefined {
  const c = categories.find((x) => x.id === id);
  if (!c) return undefined;
  return c.parent_id ? categories.find((x) => x.id === c.parent_id) : c;
}
