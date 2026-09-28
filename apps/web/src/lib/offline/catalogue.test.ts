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
  it('things and lots need the network when the phone saved no things', () => {
    expect(resolve('HL:AST:ABCDEF')).toMatchObject({ status: 'offline' });
    expect(resolve('HL:LOT:ABCDEF')).toMatchObject({ status: 'offline' });
  });
});

describe('resolveFromCatalogue: things and blank labels (Phase 7b)', () => {
  const drill = { id: 'a1', household_id: 'h1', name: 'Drill', code: 'HL:AST:DR1110', asset_no: 42, status: 'stored', location_id: 'l1', serial_no: 'x' };
  const tag = (code: string, t: Partial<{ location_id: string; asset_id: string; product_id: string; retired_at: string }>) => ({
    code,
    location_id: null,
    asset_id: null,
    product_id: null,
    retired_at: null,
    ...t,
  });
  const full: Catalogue = {
    ...cat,
    assets: [drill],
    tags: [
      tag('HL:TAG:AAAAAA', { location_id: 'l1' }),
      tag('HL:TAG:BBBBBB', { asset_id: 'a1' }),
      tag('HL:TAG:CCCCCC', { product_id: 'p1' }),
      tag('HL:TAG:DDDDDD', { retired_at: '2026-09-27T00:00:00Z' }),
    ],
  };
  const r = (raw: string) => resolveFromCatalogue(parseScan(raw), full);

  it('a saved thing resolves offline (only the scan fields)', () => {
    expect(r('HL:AST:DR1110')).toEqual({
      status: 'asset',
      asset: { id: 'a1', household_id: 'h1', name: 'Drill', code: 'HL:AST:DR1110', asset_no: 42, status: 'stored', location_id: 'l1' },
    });
  });
  it('an assigned blank label opens its place / thing / product, saying which label was scanned', () => {
    expect(r('https://gedara.vercel.app/s/HL:TAG:AAAAAA')).toMatchObject({ status: 'place', place: { id: 'l1' }, via: 'HL:TAG:AAAAAA' });
    expect(r('HL:TAG:BBBBBB')).toMatchObject({ status: 'asset', asset: { id: 'a1' }, via: 'HL:TAG:BBBBBB' });
    expect(r('HL:TAG:CCCCCC')).toMatchObject({ status: 'product', product: { id: 'p1' }, barcode: null, via: 'HL:TAG:CCCCCC' });
  });
  it('blank, retired or unknown labels need the network (only the database knows)', () => {
    expect(r('HL:TAG:DDDDDD')).toMatchObject({ status: 'offline' });
    expect(r('HL:TAG:EEEEEE')).toMatchObject({ status: 'offline' });
  });
});

describe('resolveFromCatalogue: Things by barcode (Phase 7e)', () => {
  const book = (id: string, no: number) => ({ id, household_id: 'h1', name: `Rosemaryta babek Book 0060 #${no}`, code: `HL:AST:BK00${no}0`, asset_no: no, status: 'stored', location_id: null });
  const full: Catalogue = {
    ...cat,
    assets: [book('a1', 1), book('a2', 2), book('a3', 3)],
    assetBarcodes: [
      { barcode: '9789556778052', asset_id: 'a1' },
      { barcode: '9789556778069', asset_id: 'a2' },
      { barcode: '9789556778069', asset_id: 'a3' },
    ],
  };
  const r = (raw: string) => resolveFromCatalogue(parseScan(raw), full);

  it("a book's ISBN opens the book", () => {
    expect(r('9789556778052')).toMatchObject({ status: 'asset', asset: { id: 'a1' } });
  });
  it('copies sharing an ISBN ask which one', () => {
    expect(r('9789556778069')).toMatchObject({ status: 'assetChoice', code: '9789556778069', assets: [{ id: 'a2' }, { id: 'a3' }] });
  });
  it('a Pantry barcode still wins, and an unknown ISBN is still new', () => {
    expect(r('4792024000222')).toMatchObject({ status: 'product' });
    expect(r('9780140449136')).toEqual({ status: 'unknownBarcode', code: '9780140449136' });
  });
});
