// Where a bill line goes (MASTER_PLAN §1.1): pantry stock, Things (Phase 5) or expense only.
// Builds the proposal the review screen starts from, the "2 packs = 800 g · Rs 0.55/g" preview,
// and the `route` object `rpc_import_bills` / `rpc_route_lines` apply (migration 31).
import { toStockQty, type Conversion, type UnitMap } from '../pantry/units';
import type { Confidence, Destiny, Match, Suggestion } from './match';

export interface LineRoute {
  destiny: Destiny;
  productId: string | null;
  /** How the product was found; 'user' once someone picked it by hand. */
  confidence: Confidence | 'user';
  suggestions: Suggestion[];
  /** Quantity bought, in `unitId` (converted to the product's stock unit by the database). */
  qty: number | null;
  unitId: string | null;
  /** undefined = the product's own default (place / due date); null due date = "no date". */
  locationId?: string | null;
  dueDate?: string | null;
  /** The line's printed name was already learned (so re-learning updates it). */
  known: boolean;
}

export interface RouteLine {
  raw_name: string;
  amount: number;
  qty: number | null;
  /** The line's unit as the database resolves it (unit_text → unit), if any. */
  unitId: string | null;
  /** The bill printed no unit (the scanner's `unit` was null): assume the product's purchase unit. */
  unitMissing: boolean;
  synthetic?: boolean;
}

export interface RouteProduct {
  id: string;
  stock_unit_id: string;
  purchase_unit_id: string | null;
}

/** unit_text ("Kg", "pcs", "bottle") → a unit id, the way the line trigger does it (system units first). */
export function unitByText(units: UnitMap, text: string | null | undefined): string | null {
  const key = (text ?? '').trim().toLowerCase();
  if (!key) return null;
  const hits = [...units.values()]
    .filter((u) => u.code.toLowerCase() === key || u.aliases.includes(key))
    .sort(
      (a, b) =>
        Number(a.household_id !== null) - Number(b.household_id !== null) ||
        Number(b.code.toLowerCase() === key) - Number(a.code.toLowerCase() === key),
    );
  return hits[0]?.id ?? null;
}

/** What a line bought, in which unit: the printed unit, or the product's purchase unit when none. */
export function defaultQtyUnit(line: RouteLine, product: RouteProduct): { qty: number; unitId: string } {
  const qty = line.qty && line.qty > 0 ? line.qty : 1;
  if ((line.unitMissing || !line.unitId) && product.purchase_unit_id) return { qty, unitId: product.purchase_unit_id };
  return { qty, unitId: line.unitId ?? product.stock_unit_id };
}

/** The proposal for one line. */
export function initialRoute(
  line: RouteLine,
  match: Match,
  categoryDestiny: Destiny,
  productsById: Map<string, RouteProduct>,
): LineRoute {
  const known = match.via === 'alias';
  if (line.synthetic || line.amount < 0) {
    return { destiny: 'expense', productId: null, confidence: 'sure', suggestions: [], qty: null, unitId: null, known: false };
  }
  const destiny: Destiny = match.via === 'alias' || match.via === 'barcode' ? (match.destiny ?? categoryDestiny) : categoryDestiny;
  const base: LineRoute = {
    destiny,
    productId: null,
    confidence: match.confidence,
    suggestions: match.suggestions,
    qty: null,
    unitId: null,
    known,
  };
  if (destiny !== 'stock') return base;
  const preselect = match.confidence === 'sure' || match.confidence === 'check' ? match.productId : null;
  const product = preselect ? productsById.get(preselect) : undefined;
  return product ? withProduct(base, line, product, match.confidence) : base;
}

/** Point a route at a product; the quantity/unit defaults follow the product. */
export function withProduct(route: LineRoute, line: RouteLine, product: RouteProduct, confidence: LineRoute['confidence'] = 'user'): LineRoute {
  const { qty, unitId } = defaultQtyUnit(line, product);
  return { ...route, destiny: 'stock', productId: product.id, confidence, qty, unitId, locationId: undefined, dueDate: undefined };
}

export type StockPreview = { stockQty: number; unitCost: number } | { needsPack: true } | { badQty: true };

/** How much stock the line becomes, and at what Rs per stock unit. */
export function stockPreview(
  route: Pick<LineRoute, 'qty' | 'unitId'>,
  product: RouteProduct,
  units: UnitMap,
  conversions: Conversion[],
  amount: number,
): StockPreview {
  if (!route.qty || route.qty <= 0) return { badQty: true };
  const own = conversions.filter((c) => c.product_id === product.id);
  const stockQty = toStockQty(units, product.stock_unit_id, own, route.unitId, route.qty);
  if (stockQty === null) return { needsPack: true };
  if (stockQty <= 0) return { badQty: true };
  return { stockQty, unitCost: Math.round((amount / stockQty) * 10_000) / 10_000 };
}

export type RouteProblem = 'needsProduct' | 'needsPack' | 'badQty' | null;

/**
 * A pantry line nobody picked a product for yet. It doesn't block the import: the line is saved as
 * a plain bill line (no lot) and can be sent to the pantry later from the bill page.
 */
export function isUnresolved(route: LineRoute): boolean {
  return route.destiny === 'stock' && !route.productId;
}

/** Problems that do block: a product was picked but its quantity can't become stock. */
export function isBlocking(problem: RouteProblem): boolean {
  return problem === 'needsPack' || problem === 'badQty';
}

export function routeProblem(route: LineRoute, preview: StockPreview | null): RouteProblem {
  if (route.destiny !== 'stock') return null;
  if (!route.productId) return 'needsProduct';
  if (!preview) return 'needsProduct';
  if ('needsPack' in preview) return 'needsPack';
  if ('badQty' in preview) return 'badQty';
  return null;
}

export interface RpcRoute {
  destiny: Destiny;
  product_id?: string;
  qty?: number;
  unit_id?: string | null;
  location_id?: string | null;
  due_date?: string | null;
  learn: boolean;
}

/**
 * The route the database applies. A printed name is learned when there's something to learn: a
 * product, a destiny other than the category's default, or an update of a name already known.
 */
export function toRpcRoute(route: LineRoute, categoryDestiny: Destiny, synthetic = false): RpcRoute {
  const learn = !synthetic && (route.destiny === 'stock' || route.destiny !== categoryDestiny || route.known);
  if (route.destiny !== 'stock') return { destiny: route.destiny, learn };
  const out: RpcRoute = { destiny: 'stock', product_id: route.productId ?? undefined, qty: route.qty ?? undefined, unit_id: route.unitId, learn };
  if (route.locationId !== undefined) out.location_id = route.locationId;
  if (route.dueDate !== undefined && route.dueDate !== '') out.due_date = route.dueDate;
  return out;
}

export function isDestiny(v: string | null | undefined): v is Destiny {
  return v === 'stock' || v === 'asset' || v === 'expense';
}
