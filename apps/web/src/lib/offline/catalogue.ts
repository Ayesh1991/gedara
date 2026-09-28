// Resolving a scan from the saved offline catalogue (lib/offline/persist): the same answers as
// online for products, barcodes, places, things and assigned blank labels; lots and blank labels
// nobody has assigned yet need the network. Pure, unit-tested.
import type { ParsedScan } from '../codes';
import { tagTarget, type LabelTag } from '../labels/tags';
import type { Place } from '../places';
import type { Resolved, ScanAsset, ScanProduct } from '../resolve';

// Same shape the database accepts for product_barcode.barcode (migration 24).
const BARCODE = /^[0-9A-Za-z._-]{4,64}$/;

export interface Catalogue {
  products: ScanProduct[];
  barcodes: { barcode: string; unit_id: string | null; qty: number; product_id: string }[];
  places: Place[];
  /** Phase 7b: things and the labels that mean something (optional: older saved copies lack them). */
  assets?: ScanAsset[];
  /** Phase 7e: Things' retail barcodes (copies of a book share one). */
  assetBarcodes?: { barcode: string; asset_id: string }[];
  tags?: Pick<LabelTag, 'code' | 'location_id' | 'asset_id' | 'product_id' | 'retired_at'>[];
}

const pick = (p: ScanProduct): ScanProduct => ({ id: p.id, household_id: p.household_id, name: p.name, code: p.code });
const pickAsset = (a: ScanAsset): ScanAsset => ({
  id: a.id,
  household_id: a.household_id,
  name: a.name,
  code: a.code,
  asset_no: a.asset_no,
  status: a.status,
  location_id: a.location_id,
});

/** The same answers as online, from what the phone saved; lots and unassigned labels need the network. */
export function resolveFromCatalogue(parsed: ParsedScan, c: Catalogue): Resolved {
  const byBarcode = (code: string): Resolved | null => {
    const b = c.barcodes.find((x) => x.barcode === code);
    const p = b && c.products.find((x) => x.id === b.product_id);
    if (b && p) return { status: 'product', product: pick(p), barcode: { code: b.barcode, unitId: b.unit_id, qty: Number(b.qty) } };
    const ids = new Set((c.assetBarcodes ?? []).filter((x) => x.barcode === code).map((x) => x.asset_id));
    const things = (c.assets ?? []).filter((a) => ids.has(a.id)).map(pickAsset);
    if (things.length === 1) return { status: 'asset', asset: things[0]! };
    if (things.length > 1) return { status: 'assetChoice', code, assets: things };
    return null;
  };
  switch (parsed.kind) {
    case 'unknown': {
      const text = parsed.raw.trim();
      return (BARCODE.test(text) && byBarcode(text)) || { status: 'invalid', raw: parsed.raw };
    }
    case 'grocy':
      return { status: 'grocy', raw: parsed.raw };
    case 'ean':
      return byBarcode(parsed.digits) ?? { status: 'unknownBarcode', code: parsed.digits };
    case 'prd': {
      const p = c.products.find((x) => x.code === parsed.code);
      return p ? { status: 'product', product: pick(p), barcode: null } : { status: 'notFound', code: parsed.code };
    }
    case 'loc': {
      const place = c.places.find((x) => x.code === parsed.code);
      return place ? { status: 'place', place } : { status: 'notFound', code: parsed.code };
    }
    case 'ast': {
      const a = c.assets?.find((x) => x.code === parsed.code);
      return a ? { status: 'asset', asset: pickAsset(a) } : { status: 'offline', parsed };
    }
    case 'tag': {
      const tag = c.tags?.find((x) => x.code === parsed.code);
      const target = tag && !tag.retired_at ? tagTarget(tag) : null;
      const via = parsed.code;
      if (target?.kind === 'location') {
        const place = c.places.find((x) => x.id === target.id);
        if (place) return { status: 'place', place, via };
      } else if (target?.kind === 'asset') {
        const a = c.assets?.find((x) => x.id === target.id);
        if (a) return { status: 'asset', asset: pickAsset(a), via };
      } else if (target?.kind === 'product') {
        const p = c.products.find((x) => x.id === target.id);
        if (p) return { status: 'product', product: pick(p), barcode: null, via };
      }
      // Blank (or assigned since the last sync): only the database knows.
      return { status: 'offline', parsed };
    }
    default:
      return { status: 'offline', parsed };
  }
}

