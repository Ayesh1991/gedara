// Personal inflation index (MASTER_PLAN §6 "Price intelligence"): our own basket, from what we
// actually paid per stock unit on bills (v_product_price_month). No published CCPI (Didula, 2026-09-25).
//
// Chain-linked: for each pair of consecutive months with purchases, the link is the spend-weighted
// average of price relatives (this month's Rs per unit ÷ last month's) over the products bought in
// both months; weight = what was spent on the product in the two months. Index(first month) = 100,
// Index(m) = Index(m − 1) × link. A month with no product in common carries the index unchanged
// (and says so), rather than inventing a number.

export interface PricePoint {
  product_id: string;
  product_name: string;
  month: string; // 'YYYY-MM'
  qty: number;
  spent: number;
}

export interface IndexPoint {
  month: string;
  index: number;
  /** Products compared with the previous month (0 = carried, not measured). */
  basket: number;
}

export interface Mover {
  product_id: string;
  name: string;
  firstMonth: string;
  lastMonth: string;
  first: number; // Rs per unit
  last: number;
  change: number; // last / first − 1
}

export interface InflationResult {
  points: IndexPoint[];
  /** Change from the first to the last month (null with fewer than 2 measured months). */
  change: number | null;
  movers: Mover[];
}

/** Per product and month: Rs per unit (all shops together) and the spend. */
function monthly(rows: PricePoint[]) {
  const map = new Map<string, Map<string, { qty: number; spent: number; name: string }>>();
  for (const r of rows) {
    if (!(r.qty > 0) || !(r.spent >= 0)) continue;
    const byMonth = map.get(r.product_id) ?? new Map();
    const cur = byMonth.get(r.month) ?? { qty: 0, spent: 0, name: r.product_name };
    cur.qty += r.qty;
    cur.spent += r.spent;
    byMonth.set(r.month, cur);
    map.set(r.product_id, byMonth);
  }
  return map;
}

export function personalInflation(rows: PricePoint[]): InflationResult {
  const byProduct = monthly(rows);
  const months = [...new Set(rows.map((r) => r.month))].sort();
  if (months.length === 0) return { points: [], change: null, movers: [] };

  const points: IndexPoint[] = [{ month: months[0]!, index: 100, basket: 0 }];
  let measured = 0;
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1]!;
    const cur = months[i]!;
    let wSum = 0;
    let rSum = 0;
    let basket = 0;
    for (const byMonth of byProduct.values()) {
      const a = byMonth.get(prev);
      const b = byMonth.get(cur);
      if (!a || !b || a.spent <= 0 || b.spent <= 0) continue;
      const rel = b.spent / b.qty / (a.spent / a.qty);
      const w = a.spent + b.spent;
      wSum += w;
      rSum += w * rel;
      basket++;
    }
    const link = basket > 0 ? rSum / wSum : 1;
    if (basket > 0) measured++;
    points.push({ month: cur, index: Math.round(points[i - 1]!.index * link * 100) / 100, basket });
  }

  const movers: Mover[] = [];
  for (const [product_id, byMonth] of byProduct) {
    const ms = [...byMonth.keys()].sort();
    if (ms.length < 2) continue;
    const f = byMonth.get(ms[0]!)!;
    const l = byMonth.get(ms.at(-1)!)!;
    const first = f.spent / f.qty;
    const last = l.spent / l.qty;
    if (first <= 0) continue;
    movers.push({ product_id, name: l.name, firstMonth: ms[0]!, lastMonth: ms.at(-1)!, first, last, change: last / first - 1 });
  }
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  return {
    points,
    change: measured > 0 ? points.at(-1)!.index / 100 - 1 : null,
    movers,
  };
}
