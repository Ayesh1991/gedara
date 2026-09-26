import { describe, expect, it } from 'vitest';
import { addMonths, docPrefill, matchThing, plateLine } from './docs';

describe('scanned thing documents', () => {
  it('adds warranty months, clamping to the month end', () => {
    expect(addMonths('2026-05-01', 24)).toBe('2028-05-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('a warranty card fills name, dates, shop and warranty end', () => {
    expect(
      docPrefill({ doc_type: 'warranty', maker: 'LG', product: 'Refrigerator', model: 'GL-B201', serial: ' SN1 ', purchase_date: '2026-05-01', warranty_months: 24, shop: 'Singer', price: 125000 }),
    ).toEqual({
      name: 'LG Refrigerator',
      maker: 'LG',
      model: 'GL-B201',
      serial: 'SN1',
      purchased_on: '2026-05-01',
      purchase_price: 125000,
      vendor: 'Singer',
      warranty_until: '2028-05-01',
      lifetime_warranty: false,
      description: null,
    });
  });

  it('a rating plate goes into the description as one line', () => {
    const plate = { doc_type: 'rating_plate' as const, maker: 'Samsung', model: 'RT28', power_w: 150, voltage: '220-240 V', frequency_hz: 50, capacity: '253 L' };
    expect(plateLine(plate)).toBe('Rating plate: 150 W · 220-240 V · 50 Hz · 253 L');
    expect(docPrefill(plate)).toMatchObject({ name: 'Samsung RT28', description: 'Rating plate: 150 W · 220-240 V · 50 Hz · 253 L' });
  });

  it('matches a thing by serial first, then by a unique maker + model', () => {
    const things = [
      { id: 'a', serial_no: 'SN-001', model_no: 'GL B201', manufacturer: 'LG' },
      { id: 'b', serial_no: null, model_no: 'RT28', manufacturer: 'Samsung' },
      { id: 'c', serial_no: null, model_no: 'X1', manufacturer: 'Sony' },
      { id: 'd', serial_no: null, model_no: 'X1', manufacturer: 'Sony' },
    ];
    expect(matchThing({ doc_type: 'warranty', serial: 'sn001' }, things)?.id).toBe('a');
    expect(matchThing({ doc_type: 'rating_plate', maker: 'LG', model: 'GL-B201' }, things)?.id).toBe('a');
    expect(matchThing({ doc_type: 'rating_plate', model: 'RT28' }, things)?.id).toBe('b');
    expect(matchThing({ doc_type: 'rating_plate', model: 'X1' }, things)).toBeNull();
  });
});
