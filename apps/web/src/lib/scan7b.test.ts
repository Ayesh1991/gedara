import { describe, expect, it } from 'vitest';
import { barcodeText } from './codes';
import { DEFAULT_PROFILE, MINI_PROFILE, layoutSlots } from './labels/sheet';
import { blankLabelText, tagState, tagTarget } from './labels/tags';
import { moveErrorKey } from './moveErrors';

describe('blank labels', () => {
  const blank = { location_id: null, asset_id: null, product_id: null, retired_at: null };
  it('know what they mean', () => {
    expect(tagTarget(blank)).toBeNull();
    expect(tagTarget({ ...blank, asset_id: 'a1' })).toEqual({ kind: 'asset', id: 'a1' });
    expect(tagState(blank)).toBe('blank');
    expect(tagState({ ...blank, product_id: 'p1' })).toBe('used');
    expect(tagState({ ...blank, retired_at: '2026-09-27' })).toBe('retired');
  });
  it('print their sheet and position for people (1-based), short for NIIMBOT (≤ 10 chars)', () => {
    expect(blankLabelText(7, 11)).toBe('S7 · 12');
    expect(blankLabelText(123, 299, true)).toBe('S123-300');
    expect(blankLabelText(123, 299, true).length).toBeLessThanOrEqual(10);
  });
});

describe('layoutSlots (reprints land in the same cells)', () => {
  it('puts every label in its own slot, row by row', () => {
    const placed = layoutSlots(DEFAULT_PROFILE, [{ slot: 0 }, { slot: 10 }, { slot: 53 }]);
    expect(placed.map((p) => [p.page, p.row, p.col])).toEqual([
      [0, 0, 0],
      [0, 1, 1],
      [0, 5, 8],
    ]);
  });
  it('"only unused" keeps the gaps where used labels were', () => {
    expect(layoutSlots(DEFAULT_PROFILE, [{ slot: 2 }, { slot: 9 }]).map((p) => p.rect.x)).toEqual([66, 0]);
  });
  it('a slot beyond one page (grid made smaller since) continues on the next page', () => {
    expect(layoutSlots(DEFAULT_PROFILE, [{ slot: 54 }])[0]).toMatchObject({ page: 1, row: 0, col: 0 });
    expect(MINI_PROFILE.rows * MINI_PROFILE.cols).toBeLessThanOrEqual(300);
  });
});

describe('moveErrorKey', () => {
  it('maps database refusals and parked-op errors alike', () => {
    expect(moveErrorKey({ code: 'GDMVC', details: 'moved' })).toBe('moved');
    expect(moveErrorKey({ code: 'GDMVC', detail: 'newer' })).toBe('newer');
    expect(moveErrorKey({ code: '23514' })).toBe('cycle');
    expect(moveErrorKey({ code: '42501' })).toBe('denied');
    expect(moveErrorKey(new Error('x'))).toBe('generic');
  });
});

describe('barcodeText (camera / USB into a barcode field)', () => {
  it('keeps GTIN digits and trims anything else', () => {
    expect(barcodeText(' 4792024000222\n')).toBe('4792024000222');
    expect(barcodeText('  SHOP-123 ')).toBe('SHOP-123');
  });
});
