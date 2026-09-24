// Units and conversions for the pantry (MASTER_PLAN §3.2, CLAUDE.md rule 4).
// The same rules as `private.to_stock_qty` in migration 26, so the app can preview "2 packs =
// 800 g" and offer only units the database will accept. The database stays the authority.

export type Dimension = 'mass' | 'volume' | 'count' | 'energy' | 'length' | 'other';

export interface Unit {
  id: string;
  household_id: string | null;
  code: string;
  name: string;
  dimension: Dimension | string;
  to_base: number;
  aliases: string[];
}

export interface Conversion {
  product_id: string;
  from_unit_id: string;
  to_unit_id: string;
  factor: number; // 1 from_unit = factor × to_unit
}

export type UnitMap = Map<string, Unit>;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Factor from one unit to another when they measure the same thing ('other' never converts). */
export function unitFactor(units: UnitMap, from: string, to: string): number | null {
  if (from === to) return 1;
  const f = units.get(from);
  const t = units.get(to);
  if (!f || !t || f.dimension !== t.dimension || f.dimension === 'other') return null;
  return f.to_base / t.to_base;
}

/** qty in `unitId` → qty in the product's stock unit, or null when it can't be converted. */
export function toStockQty(
  units: UnitMap,
  stockUnitId: string,
  conversions: Conversion[],
  unitId: string | null | undefined,
  qty: number,
): number | null {
  if (!unitId || unitId === stockUnitId) return round4(qty);
  const direct = unitFactor(units, unitId, stockUnitId);
  if (direct !== null) return round4(qty * direct);
  for (const c of conversions) {
    if (c.from_unit_id !== unitId) continue;
    const f = unitFactor(units, c.to_unit_id, stockUnitId);
    if (f !== null) return round4(qty * c.factor * f);
  }
  for (const c of conversions) {
    if (c.from_unit_id !== stockUnitId) continue;
    const f = unitFactor(units, unitId, c.to_unit_id);
    if (f !== null) return round4((qty * f) / c.factor);
  }
  return null;
}

/** Every unit a quantity of this product can be entered in (stock unit first). */
export function usableUnits(units: UnitMap, stockUnitId: string, conversions: Conversion[]): Unit[] {
  const stock = units.get(stockUnitId);
  const rest = [...units.values()]
    .filter((u) => u.id !== stockUnitId && toStockQty(units, stockUnitId, conversions, u.id, 1) !== null)
    .sort((a, b) => a.dimension.localeCompare(b.dimension) || a.to_base - b.to_base || a.code.localeCompare(b.code));
  return stock ? [stock, ...rest] : rest;
}

// ── Display ───────────────────────────────────────────────────────────────────

/** A bigger unit to show large amounts in: 1 500 g → 1.5 kg, 2 000 ml → 2 L. */
const BIGGER: Record<string, { code: string; factor: number }> = {
  g: { code: 'kg', factor: 1000 },
  ml: { code: 'L', factor: 1000 },
};

const nf = (max: number) => new Intl.NumberFormat('en-LK', { maximumFractionDigits: max });

/** "1.5 kg", "750 g", "12 pcs", "2 packs"-style text for a quantity in a unit. */
export function formatQty(qty: number, unit: Pick<Unit, 'code'> | undefined): string {
  if (!unit) return nf(3).format(qty);
  const big = BIGGER[unit.code];
  if (big && Math.abs(qty) >= big.factor) return `${nf(3).format(qty / big.factor)} ${big.code}`;
  return `${nf(qty % 1 === 0 ? 0 : 3).format(qty)} ${unit.code}`;
}

/**
 * A per-unit price people can judge at a glance (§0.1 #1, the "$6 M" bug): Rs per kg / L for mass
 * and volume, otherwise per stock unit. `unitCost` is Rs per stock unit.
 */
export function pricePer(unitCost: number, stockUnit: Pick<Unit, 'code' | 'dimension' | 'to_base'> | undefined):
  | { amount: number; per: string }
  | null {
  if (!stockUnit) return null;
  if (stockUnit.dimension === 'mass') return { amount: (unitCost * 1000) / stockUnit.to_base, per: 'kg' };
  if (stockUnit.code === 'ml' || stockUnit.code === 'L') return { amount: (unitCost * 1000) / stockUnit.to_base, per: 'L' };
  return { amount: unitCost, per: stockUnit.code };
}

/** Parses "1.5", "2" or "1,000" (en-LK thousands separator); null when it isn't a number ≥ 0. */
export function parseQty(text: string): number | null {
  const t = text.trim().replace(/,(?=\d{3}(?!\d))/g, '');
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? round4(n) : null;
}
