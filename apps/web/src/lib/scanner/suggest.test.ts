import { describe, expect, it } from 'vitest';
import { linkOnly, nameWords, packFromOff, suggestProducts, type SuggestProduct } from './suggest';

const p = (id: string, name: string, qty: number, created_at: string, archived = false): SuggestProduct => ({
  id,
  name,
  archived,
  created_at,
  stock: { qty },
});

const PRODUCTS = [
  p('yog', 'Highland Yoghurt', 3, '2026-11-01'),
  p('curd', 'Highland Curd', 1, '2026-11-12'),
  p('milk', 'Anchor Milk Powder 400g', 2, '2026-11-13'),
  p('old', 'Highland Yoghurt (old)', 0, '2026-01-01', true),
  p('rice', 'Keeri Samba Rice', 0, '2026-11-14'),
  p('salt', 'Salt', 5, '2026-10-01'),
];

describe('nameWords', () => {
  it('drops sizes, units and filler words', () => {
    expect([...nameWords('Anchor Full Cream Milk Powder 400 g')]).toEqual(['anchor', 'full', 'cream', 'milk', 'powder']);
  });
});

describe('suggestProducts', () => {
  it('ranks by shared words and skips archived products', () => {
    const s = suggestProducts(PRODUCTS, new Set(), 'Highland Set Yogurt 80 g');
    expect(s.map((x) => x.id)).toEqual(['yog', 'curd']);
  });

  it('puts a product without a barcode before an equal match that has one', () => {
    const s = suggestProducts(PRODUCTS, new Set(['yog']), 'Highland');
    expect(s.map((x) => x.id)).toEqual(['curd', 'yog']);
    expect(s[1]!.hasBarcode).toBe(true);
  });

  it('without a name offers the newest in-stock products with no barcode', () => {
    const s = suggestProducts(PRODUCTS, new Set(['curd']), null);
    expect(s.map((x) => x.id)).toEqual(['milk', 'yog', 'salt']);
  });

  it('falls back the same way when no word matches', () => {
    expect(suggestProducts(PRODUCTS, new Set(), 'Munchee Lemon Puff').map((x) => x.id)).toEqual(['milk', 'curd', 'yog', 'salt']);
  });

  it('keeps to the limit', () => {
    expect(suggestProducts(PRODUCTS, new Set(), null, 2)).toHaveLength(2);
  });
});

describe('linkOnly', () => {
  it('is a Check scan with nothing else waiting', () => {
    expect(linkOnly('check', 1)).toBe(true);
    expect(linkOnly('check', 2)).toBe(false);
    expect(linkOnly('use', 1)).toBe(false);
    expect(linkOnly(null, 1)).toBe(false);
  });
});

describe('packFromOff', () => {
  it('uses the pack size only when it measures the same thing', () => {
    expect(packFromOff({ qty: 400, unit: 'g' }, 'mass')).toEqual({ qty: 400, unitCode: 'g' });
    expect(packFromOff({ qty: 1000, unit: 'ml' }, 'volume')).toEqual({ qty: 1000, unitCode: 'ml' });
    expect(packFromOff({ qty: 400, unit: 'g' }, 'count')).toBeNull();
    expect(packFromOff({ qty: 6, unit: 'pcs' }, 'count')).toBeNull();
    expect(packFromOff(null, 'mass')).toBeNull();
  });
});
