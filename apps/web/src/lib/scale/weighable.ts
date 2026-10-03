// Which products a kitchen container can hold: those whose stock unit converts to grams (g, kg, or a
// pack with a weight, "1 pack = 400 g") — the same rule the database checks (GDUNT, migration 63).
import { toStockQty, type Conversion, type UnitMap } from '../pantry/units';

export function isWeighable(
  product: { id: string; stock_unit_id: string },
  units: UnitMap,
  conversions: Conversion[],
): boolean {
  const g = [...units.values()].find((u) => u.household_id === null && u.code === 'g');
  if (!g) return false;
  const own = conversions.filter((c) => c.product_id === product.id);
  return toStockQty(units, product.stock_unit_id, own, g.id, 1000) !== null;
}
