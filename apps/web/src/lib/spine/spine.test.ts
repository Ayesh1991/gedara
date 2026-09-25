import { describe, expect, it } from 'vitest';
import { ScannedBillSchema, scannedToImport, toRpcBill } from '../money/billSchema';
import type { CategoryRow } from '../money/categoriesMap';
import type { Unit, UnitMap } from '../pantry/units';
import { buildMatcher, containment, nameScore, similarity, trigrams, type Match } from './match';
import { billNameNorm } from './normalise';
import { defaultQtyUnit, initialRoute, isBlocking, isUnresolved, routeProblem, stockPreview, toRpcRoute, unitByText, withProduct, type LineRoute, type RouteLine } from './route';
import { splitList } from './shopping';
import { billSummary } from './summary';

// Same examples as supabase/tests/database/spine_rls.test.sql (private.bill_name_norm).
describe('billNameNorm', () => {
  it('matches the database', () => {
    expect(billNameNorm('  ANCHOR Hot-Choc. 400g  (Pouch) ')).toBe('anchor hot choc 400g pouch');
    expect(billNameNorm('Kist [Mayo] {x}~_ සීනි')).toBe('kist mayo x සීනි');
    expect(billNameNorm('Aquafina Drinking-Water')).toBe('aquafina drinking water');
    expect(billNameNorm(null)).toBe('');
  });
});

describe('trigrams', () => {
  it('pads words like pg_trgm', () => {
    expect([...trigrams('Cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'].sort());
  });
  it('scores equal names 1 and unrelated names ~0', () => {
    expect(similarity(trigrams('Sugar'), trigrams('SUGAR'))).toBe(1);
    expect(similarity(trigrams('Sugar'), trigrams('Toothpaste'))).toBe(0);
  });
  it('finds a product name inside a longer bill line', () => {
    expect(containment(trigrams('Hot chocolate'), trigrams('Anchor Hot Chocolate'))).toBe(1);
    expect(nameScore([trigrams('Hot chocolate')], trigrams('Anchor Hot Chocolate'))).toBeGreaterThanOrEqual(0.7);
  });
  it('prefers the product that explains more of the line', () => {
    const line = trigrams('White Sugar 1kg pack');
    expect(nameScore([trigrams('Sugar 1kg')], line)).toBeGreaterThan(nameScore([trigrams('Sugar')], line) + 0.05);
  });
});

// Cargills sample (reference/bill-scanner/samples/bill_2026-08-22_cargills_food_city.json) vs a
// small pantry.
const GROCERY = 'top-grocery';
const CONSUMABLE = 'top-consumable';
const products = [
  { id: 'p-choc', name: 'Hot chocolate', name_si: null, archived: false, category_id: 'c-beverages' },
  { id: 'p-coco', name: 'Coconut milk', name_si: null, archived: false, category_id: 'c-dairy' },
  { id: 'p-eggs', name: 'Eggs', name_si: 'බිත්තර', archived: false, category_id: 'c-eggs' },
  { id: 'p-mayo', name: 'Mayonnaise', name_si: null, archived: false, category_id: 'c-sauces' },
  { id: 'p-salt', name: 'Salt', name_si: null, archived: false, category_id: 'c-spices' },
  { id: 'p-comfort', name: 'Fabric conditioner', name_si: null, archived: false, category_id: 'c-cleaning' },
  { id: 'p-old', name: 'Chilli pieces', name_si: null, archived: true, category_id: 'c-spices' },
];
const TOPS: Record<string, string> = {
  'c-beverages': GROCERY, 'c-dairy': GROCERY, 'c-eggs': GROCERY, 'c-sauces': GROCERY, 'c-spices': GROCERY,
  'c-cleaning': CONSUMABLE, 'c-snacks': GROCERY,
};
const matcher = buildMatcher({
  products,
  aliases: [
    { alias_norm: 'havana brown egg medium', product_id: 'p-eggs', destiny: 'stock' },
    { alias_norm: 'aquafina drinking water', product_id: null, destiny: 'expense' },
  ],
  barcodes: [{ barcode: '4792024000222', product_id: 'p-mayo' }],
  topOf: (id) => (id ? (TOPS[id] ?? null) : null),
});

describe('matching', () => {
  it('a barcode printed on the bill is sure', () => {
    const m = matcher.match({ raw_name: 'Kist something', barcode: '4792024000222' });
    expect([m.productId, m.via, m.confidence]).toEqual(['p-mayo', 'barcode', 'sure']);
  });
  it('a learned name is sure, however it was printed', () => {
    const m = matcher.match({ raw_name: 'HAVANA Brown Egg - Medium' });
    expect([m.productId, m.via, m.confidence]).toEqual(['p-eggs', 'alias', 'sure']);
  });
  it('a name learned as "not stock" says so', () => {
    const m = matcher.match({ raw_name: 'Aquafina Drinking Water' });
    expect([m.productId, m.destiny, m.confidence]).toEqual([null, 'expense', 'sure']);
  });
  it('a product name inside the line is pre-selected to check', () => {
    const m = matcher.match({ raw_name: 'Anchor Hot Chocolate', categoryTop: GROCERY });
    expect([m.productId, m.via, m.confidence]).toEqual(['p-choc', 'name', 'check']);
    expect(matcher.match({ raw_name: 'Sera Real Coconut Milk', categoryTop: GROCERY }).productId).toBe('p-coco');
    expect(matcher.match({ raw_name: 'Kist Mayonnaise Pouch', categoryTop: GROCERY }).confidence).toBe('check');
  });
  it('a product from another top-level category is only suggested', () => {
    const m = matcher.match({ raw_name: 'Salted peanuts', categoryTop: CONSUMABLE });
    expect(m.confidence).toBe('maybe');
    expect(m.productId).toBe('p-salt');
  });
  it('nothing close → none; archived products are never proposed', () => {
    expect(matcher.match({ raw_name: 'Bic Twin Lady Razor' }).confidence).toBe('none');
    expect(matcher.match({ raw_name: 'Wijaya Chilli Pieces' }).productId).not.toBe('p-old');
  });
  it('an ambiguous name is only a suggestion', () => {
    const m2 = buildMatcher({
      products: [
        { id: 'a', name: 'Rice keeri samba', name_si: null, archived: false, category_id: null },
        { id: 'b', name: 'Rice samba keeri', name_si: null, archived: false, category_id: null },
      ],
      aliases: [],
      barcodes: [],
    });
    expect(m2.match({ raw_name: 'Keeri samba rice 5kg' }).confidence).toBe('maybe');
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
const u = (id: string, code: string, dimension: string, to_base: number, aliases: string[] = []): Unit => ({
  id, household_id: null, code, name: code, dimension, to_base, aliases,
});
const units: UnitMap = new Map(
  [u('g', 'g', 'mass', 1, ['gram']), u('kg', 'kg', 'mass', 1000, ['kilo']), u('pcs', 'pcs', 'count', 1, ['pc', 'nos']),
   u('pack', 'pack', 'other', 1, ['pkt'])].map((x) => [x.id, x]),
);
const sugar = { id: 'p-sugar', stock_unit_id: 'g', purchase_unit_id: 'pack' };
const eggs = { id: 'p-eggs', stock_unit_id: 'pcs', purchase_unit_id: 'pack' };
const choc = { id: 'p-choc', stock_unit_id: 'g', purchase_unit_id: null };
const conversions = [
  { product_id: 'p-sugar', from_unit_id: 'pack', to_unit_id: 'g', factor: 400 },
  { product_id: 'p-eggs', from_unit_id: 'pack', to_unit_id: 'pcs', factor: 10 },
];
const byId = new Map([sugar, eggs, choc].map((p) => [p.id, p]));
const line = (over: Partial<RouteLine> = {}): RouteLine => ({
  raw_name: 'x', amount: 440, qty: 2, unitId: 'pcs', unitMissing: true, ...over,
});
const m = (over: Partial<Match> = {}): Match => ({
  productId: null, destiny: null, via: null, score: 0, confidence: 'none', suggestions: [], ...over,
});

describe('routes', () => {
  it('unit text resolves like the database (code or alias, case-insensitive)', () => {
    expect(unitByText(units, 'Kg')).toBe('kg');
    expect(unitByText(units, 'PKT')).toBe('pack');
    expect(unitByText(units, '')).toBeNull();
  });
  it('no printed unit → the product\'s purchase unit; a printed one is kept', () => {
    expect(defaultQtyUnit(line(), eggs)).toEqual({ qty: 2, unitId: 'pack' });
    expect(defaultQtyUnit(line({ unitMissing: false, unitId: 'kg', qty: 1 }), sugar)).toEqual({ qty: 1, unitId: 'kg' });
    expect(defaultQtyUnit(line({ qty: null }), choc)).toEqual({ qty: 1, unitId: 'pcs' });
  });
  it('discounts and the rounding line are always expense', () => {
    expect(initialRoute(line({ amount: -10 }), m({ productId: 'p-sugar', confidence: 'sure', via: 'alias', destiny: 'stock' }), 'stock', byId).destiny).toBe('expense');
    expect(initialRoute(line({ synthetic: true }), m(), 'stock', byId).destiny).toBe('expense');
  });
  it('a learned "not stock" beats the category; otherwise the category decides', () => {
    expect(initialRoute(line(), m({ via: 'alias', destiny: 'expense', confidence: 'sure' }), 'stock', byId).destiny).toBe('expense');
    expect(initialRoute(line(), m(), 'asset', byId).destiny).toBe('asset');
    const r = initialRoute(line(), m(), 'stock', byId);
    expect([r.destiny, r.productId]).toEqual(['stock', null]);
  });
  it('sure and check matches are pre-selected with the product\'s units; maybe is not', () => {
    const r = initialRoute(line(), m({ productId: 'p-sugar', via: 'name', confidence: 'check' }), 'stock', byId);
    expect([r.productId, r.qty, r.unitId, r.confidence]).toEqual(['p-sugar', 2, 'pack', 'check']);
    expect(initialRoute(line(), m({ productId: 'p-sugar', via: 'name', confidence: 'maybe' }), 'stock', byId).productId).toBeNull();
  });
  it('previews stock and Rs per stock unit; flags a missing pack size', () => {
    const r = withProduct(initialRoute(line(), m(), 'stock', byId), line(), sugar);
    expect(stockPreview(r, sugar, units, conversions, 440)).toEqual({ stockQty: 800, unitCost: 0.55 });
    const c = withProduct(initialRoute(line(), m(), 'stock', byId), line(), choc); // 2 pcs of a product counted in g
    const p = stockPreview(c, choc, units, conversions, 260);
    expect(p).toEqual({ needsPack: true });
    expect(routeProblem(c, p)).toBe('needsPack');
    expect(stockPreview({ qty: 400, unitId: 'g' }, choc, units, conversions, 260)).toEqual({ stockQty: 400, unitCost: 0.65 });
    expect(routeProblem(initialRoute(line(), m(), 'stock', byId), null)).toBe('needsProduct');
    expect(stockPreview({ qty: 0, unitId: 'g' }, choc, units, conversions, 260)).toEqual({ badQty: true });
  });
  it('builds the RPC route and learns only when there is something to learn', () => {
    const stock = withProduct(initialRoute(line(), m(), 'stock', byId), line(), sugar);
    expect(toRpcRoute(stock, 'stock')).toEqual({ destiny: 'stock', product_id: 'p-sugar', qty: 2, unit_id: 'pack', learn: true });
    expect(toRpcRoute({ ...stock, locationId: 'loc', dueDate: null }, 'stock')).toMatchObject({ location_id: 'loc', due_date: null });
    const exp = initialRoute(line(), m(), 'expense', byId);
    expect(toRpcRoute(exp, 'expense')).toEqual({ destiny: 'expense', learn: false });
    expect(toRpcRoute({ ...exp, known: true }, 'expense').learn).toBe(true);
    expect(toRpcRoute({ ...exp }, 'stock').learn).toBe(true); // "not stock" is worth remembering
    expect(toRpcRoute(stock, 'stock', true).learn).toBe(false);
  });
});

describe('unresolved lines', () => {
  it('a pantry line without a product does not block; a bad quantity does', () => {
    const r = initialRoute(line(), m(), 'stock', byId);
    expect([isUnresolved(r), isBlocking(routeProblem(r, null))]).toEqual([true, false]);
    expect(isBlocking('needsPack')).toBe(true);
    expect(isUnresolved(withProduct(r, line(), sugar))).toBe(false);
  });
});

describe('summary', () => {
  it('counts destinies, new products and list ticks (product items + picked free text)', () => {
    const r = (destiny: 'stock' | 'asset' | 'expense', productId: string | null): LineRoute => ({
      destiny, productId, confidence: 'sure', suggestions: [], qty: 1, unitId: 'g', known: false,
    });
    const s = billSummary(
      [r('stock', 'a'), r('stock', 'b'), r('stock', 'b'), r('expense', null), r('asset', null)],
      [{ id: 'i1', product_id: 'a' }, { id: 'i2', product_id: 'c' }, { id: 'i3', product_id: null }],
      ['i3'],
      new Set(['b']),
    );
    expect(s).toEqual({ lines: 5, stock: 3, asset: 1, expense: 1, newProducts: 1, ticked: 2, tickedItemIds: ['i1'] });
  });
});

describe('shopping list', () => {
  const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, product_name: name, free_text: null, source: 'manual', done: false, dismissed: false, done_at: null, created_at: '2026-09-25', ...over,
  });
  it('below-minimum first, then by name; dismissed hidden; bought latest first', () => {
    const { open, done } = splitList([
      row('1', 'bread'), row('2', 'Apples'), row('3', 'Sugar', { source: 'below_min' }), row('4', 'Tea', { dismissed: true }),
      row('5', 'Milk', { done: true, done_at: '2026-09-24T10:00:00Z' }), row('6', 'Salt', { done: true, done_at: '2026-09-25T10:00:00Z' }),
    ]);
    expect(open.map((i) => i.id)).toEqual(['3', '2', '1']);
    expect(done.map((i) => i.id)).toEqual(['6', '5']);
  });
});

describe('bill schema (Phase 4 fields)', () => {
  const cats: CategoryRow[] = [
    { id: 'g', parent_id: null, key: 'grocery', name: 'Grocery', kind: 'expense', sort: 1, archived: false, icon: null, color: null, default_destiny: 'stock' },
  ];
  it('accepts a printed barcode and marks lines without a unit', () => {
    const bill = ScannedBillSchema.parse({
      shop: 'Keells', date: '2026-09-25', total: 300,
      items: [{ name: 'Sugar', amount: 300, qty: 1, barcode: 4792024000222 }, ],
    });
    const imp = scannedToImport(bill, cats, 'acc');
    expect(imp.lines[0]).toMatchObject({ barcode: '4792024000222', unitMissing: true, unit_text: 'pcs' });
    const rpc = toRpcBill({ ...imp, lines: imp.lines.map((l) => ({ ...l, route: { destiny: 'expense', learn: false } })) });
    expect(rpc.lines[0]).not.toHaveProperty('barcode');
    expect(rpc.lines[0]).not.toHaveProperty('unitMissing');
    expect(rpc.lines[0]!.route).toEqual({ destiny: 'expense', learn: false });
  });
  it('rejects a barcode that isn\'t one', () => {
    expect(() => ScannedBillSchema.parse({ date: '2026-09-25', items: [{ name: 'x', amount: 1, barcode: '<script>' }] })).toThrow();
  });
});
