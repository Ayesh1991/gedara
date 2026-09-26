// Resolving a scan from the saved offline catalogue (lib/offline/persist): the same answers as
// online for products, barcodes and places; things and lots need the network. Pure, unit-tested.
import type { ParsedScan } from '../codes';
import type { Place } from '../places';
import type { Resolved, ScanProduct } from '../resolve';

// Same shape the database accepts for product_barcode.barcode (migration 24).
const BARCODE = /^[0-9A-Za-z._-]{4,64}$/;

export interface Catalogue {
  products: ScanProduct[];
  barcodes: { barcode: string; unit_id: string | null; qty: number; product_id: string }[];
  places: Place[];
}

const pick = (p: ScanProduct): ScanProduct => ({ id: p.id, household_id: p.household_id, name: p.name, code: p.code });

/** The same answers as online, from what the phone saved; things and lots need the network. */
export function resolveFromCatalogue(parsed: ParsedScan, c: Catalogue): Resolved {
  const byBarcode = (code: string): Resolved | null => {
    const b = c.barcodes.find((x) => x.barcode === code);
    const p = b && c.products.find((x) => x.id === b.product_id);
    return b && p ? { status: 'product', product: pick(p), barcode: { code: b.barcode, unitId: b.unit_id, qty: Number(b.qty) } } : null;
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
    default:
      return { status: 'offline', parsed };
  }
}

