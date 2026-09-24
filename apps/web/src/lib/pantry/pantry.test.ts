import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, dueState, matchesFilter, stockStatuses } from './status';
import { formatQty, parseQty, pricePer, toStockQty, unitFactor, usableUnits, type Unit, type UnitMap } from './units';

const u = (id: string, code: string, dimension: string, to_base: number): Unit => ({
  id,
  household_id: null,
  code,
  name: code,
  dimension,
  to_base,
  aliases: [],
});
const units: UnitMap = new Map(
  [
    u('g', 'g', 'mass', 1),
    u('kg', 'kg', 'mass', 1000),
    u('ml', 'ml', 'volume', 1),
    u('L', 'L', 'volume', 1000),
    u('pcs', 'pcs', 'count', 1),
    u('pack', 'pack', 'other', 1),
    u('bottle', 'bottle', 'other', 1),
  ].map((x) => [x.id, x]),
);

// The same cases as supabase/tests/database/stock_rpcs.test.sql, so app previews match the database.
describe('unit conversion (mirrors private.to_stock_qty)', () => {
  const sugarPack = [{ product_id: 's', from_unit_id: 'pack', to_unit_id: 'kg', factor: 0.4 }];
  const coffeeBottle = [{ product_id: 'c', from_unit_id: 'bottle', to_unit_id: 'g', factor: 50 }];

  it('scales within a dimension', () => {
    expect(unitFactor(units, 'kg', 'g')).toBe(1000);
    expect(unitFactor(units, 'L', 'ml')).toBe(1000);
    expect(unitFactor(units, 'pcs', 'g')).toBeNull();
    expect(unitFactor(units, 'pack', 'bottle')).toBeNull();
  });

  it('uses product conversions forwards and backwards', () => {
    expect(toStockQty(units, 'g', sugarPack, 'pack', 2)).toBe(800);
    expect(toStockQty(units, 'g', sugarPack, 'kg', 1.2)).toBe(1200);
    expect(toStockQty(units, 'g', sugarPack, null, 5)).toBe(5);
    expect(toStockQty(units, 'bottle', coffeeBottle, 'g', 100)).toBe(2);
    expect(toStockQty(units, 'bottle', coffeeBottle, 'kg', 0.1)).toBe(2);
    expect(toStockQty(units, 'g', sugarPack, 'pcs', 1)).toBeNull();
  });

  it('lists the units a product can be entered in, stock unit first', () => {
    expect(usableUnits(units, 'g', sugarPack).map((x) => x.code)).toEqual(['g', 'kg', 'pack']);
    expect(usableUnits(units, 'pcs', []).map((x) => x.code)).toEqual(['pcs']);
  });
});

describe('display', () => {
  it('shows big amounts in the bigger unit', () => {
    expect(formatQty(1500, units.get('g'))).toBe('1.5 kg');
    expect(formatQty(750, units.get('g'))).toBe('750 g');
    expect(formatQty(12, units.get('pcs'))).toBe('12 pcs');
    expect(formatQty(2500, units.get('ml'))).toBe('2.5 L');
    expect(formatQty(0.25, units.get('pack'))).toBe('0.25 pack');
  });

  it('prices per kg / L so a wrong price is obvious', () => {
    expect(pricePer(0.55, units.get('g'))).toEqual({ amount: 550, per: 'kg' });
    expect(pricePer(300, units.get('kg'))).toEqual({ amount: 300, per: 'kg' });
    expect(pricePer(0.4, units.get('ml'))).toEqual({ amount: 400, per: 'L' });
    expect(pricePer(55, units.get('pcs'))).toEqual({ amount: 55, per: 'pcs' });
  });

  it('parses keypad quantities', () => {
    expect(parseQty('1.5')).toBe(1.5);
    expect(parseQty(' 2 ')).toBe(2);
    expect(parseQty('.5')).toBe(0.5);
    expect(parseQty('1,000')).toBe(1000);
    expect(parseQty('1,5')).toBeNull();
    expect(parseQty('-1')).toBeNull();
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('')).toBeNull();
  });
});

describe('status chips', () => {
  const today = '2026-09-24';

  it('counts days and adds them', () => {
    expect(daysBetween('2026-09-24', '2026-09-29')).toBe(5);
    expect(daysBetween('2026-09-24', '2026-09-23')).toBe(-1);
    expect(addDays('2026-09-24', 30)).toBe('2026-10-24');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('keeps expiry (red) and best-before (amber) apart', () => {
    expect(dueState('expiry', '2026-09-23', today)).toBe('expired');
    expect(dueState('best_before', '2026-09-23', today)).toBe('bbPassed');
    expect(dueState('best_before', '2026-09-29', today)).toBe('dueSoon');
    expect(dueState('expiry', '2026-09-24', today)).toBe('dueSoon');
    expect(dueState('best_before', '2026-09-30', today)).toBeNull();
    expect(dueState('none', '2020-01-01', today)).toBeNull();
    expect(dueState('expiry', null, today)).toBeNull();
  });

  it('lists every chip, most urgent first', () => {
    const base = { due_type: 'expiry', next_due: '2026-09-20', qty: 3, qty_opened: 1, below_min: true };
    expect(stockStatuses(base, today)).toEqual(['expired', 'belowMin', 'opened']);
    expect(stockStatuses({ ...base, qty: 0, qty_opened: 0 }, today)).toEqual(['belowMin', 'out']);
    expect(stockStatuses({ ...base, next_due: null, below_min: false, qty_opened: 0 }, today)).toEqual([]);
  });

  it('filters', () => {
    expect(matchesFilter(['opened'], 'attention')).toBe(false);
    expect(matchesFilter(['dueSoon', 'opened'], 'attention')).toBe(true);
    expect(matchesFilter(['out'], 'out')).toBe(true);
    expect(matchesFilter([], 'all')).toBe(true);
  });
});
