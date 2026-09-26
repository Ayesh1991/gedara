import { describe, expect, it } from 'vitest';
import { parseScan } from '../codes';
import type { Place } from '../places';
import { resolveFromCatalogue, type Catalogue } from './catalogue';

const sugar = { id: 'p1', household_id: 'h1', name: 'Sugar', code: 'HL:PRD:7K2P9Q', extra: 'dropped' };
const cat: Catalogue = {
  products: [sugar],
  barcodes: [{ barcode: '4792024000222', unit_id: 'u-pack', qty: 1, product_id: 'p1' }, { barcode: 'SHOP-123', unit_id: null, qty: 2, product_id: 'p1' }],
  places: [{ id: 'l1', code: 'HL:LOC:ABCDEF', name: 'Store room' } as Place],
};
const resolve = (raw: string) => resolveFromCatalogue(parseScan(raw), cat);

describe('resolveFromCatalogue (offline scans)', () => {
  it('a known retail barcode is the product, with its pack', () => {
    expect(resolve('4792024000222')).toEqual({
      status: 'product',
      product: { id: 'p1', household_id: 'h1', name: 'Sugar', code: 'HL:PRD:7K2P9Q' },
      barcode: { code: '4792024000222', unitId: 'u-pack', qty: 1 },
    });
  });
  it('a shop code (not a GTIN) also resolves', () => {
    expect(resolve('SHOP-123')).toMatchObject({ status: 'product', barcode: { qty: 2, unitId: null } });
  });
  it('an unknown valid EAN offers a new product', () => {
    expect(resolve('4006381333931')).toEqual({ status: 'unknownBarcode', code: '4006381333931' });
  });
  it('product and place labels resolve; unknown ones say not found', () => {
    expect(resolve('HL:PRD:7K2P9Q')).toMatchObject({ status: 'product', barcode: null });
    expect(resolve('HL:LOC:ABCDEF')).toMatchObject({ status: 'place', place: { id: 'l1' } });
    expect(resolve('HL:LOC:ZZZZZZ')).toEqual({ status: 'notFound', code: 'HL:LOC:ZZZZZZ' });
  });
  it('things and lots need the network', () => {
    expect(resolve('HL:AST:ABCDEF')).toMatchObject({ status: 'offline' });
    expect(resolve('HL:LOT:ABCDEF')).toMatchObject({ status: 'offline' });
  });
});
