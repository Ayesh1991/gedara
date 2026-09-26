// A scanned warranty card / rating plate → the thing form's prefill, and which existing thing it is
// probably about. Pure (unit-tested).
import type { RatingPlateDoc, ThingDoc, WarrantyDoc } from '@scan/schema.ts';

export interface DocPrefill {
  name?: string;
  purchase_price?: number | null;
  purchased_on?: string | null;
  vendor?: string | null;
  warranty_until?: string | null;
  lifetime_warranty?: boolean;
  maker?: string | null;
  model?: string | null;
  serial?: string | null;
  description?: string | null;
}

/** "2026-05-01" + 24 months → "2028-05-01" (end of month when the day doesn't exist). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const clean = (s: string | null | undefined) => (s ?? '').trim() || null;

function nameOf(doc: ThingDoc): string {
  return [clean(doc.maker), clean(doc.product) ?? clean(doc.model)].filter(Boolean).join(' ').slice(0, 80);
}

/** The rating plate's numbers as one readable line for the thing's description. */
export function plateLine(p: RatingPlateDoc): string {
  const parts = [
    p.power_w != null ? `${p.power_w} W` : null,
    clean(p.voltage),
    p.frequency_hz != null ? `${p.frequency_hz} Hz` : null,
    p.current_a != null ? `${p.current_a} A` : null,
    clean(p.capacity),
    clean(p.energy_rating),
    clean(p.refrigerant),
    p.manufactured ? `made ${p.manufactured}` : null,
    clean(p.country),
  ].filter(Boolean);
  return parts.length ? `Rating plate: ${parts.join(' · ')}` : '';
}

export function docPrefill(doc: ThingDoc): DocPrefill {
  const base: DocPrefill = {
    name: nameOf(doc) || undefined,
    maker: clean(doc.maker),
    model: clean(doc.model),
    serial: clean(doc.serial),
  };
  if (doc.doc_type === 'warranty') {
    const w = doc as WarrantyDoc;
    const until = w.warranty_until ?? (w.purchase_date && w.warranty_months ? addMonths(w.purchase_date, w.warranty_months) : null);
    return {
      ...base,
      purchased_on: w.purchase_date ?? null,
      purchase_price: w.price ?? null,
      vendor: clean(w.shop),
      warranty_until: w.lifetime ? null : until,
      lifetime_warranty: Boolean(w.lifetime),
      description: clean(w.notes),
    };
  }
  const line = plateLine(doc as RatingPlateDoc);
  return { ...base, description: [line, clean(doc.notes)].filter(Boolean).join('\n') || null };
}

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The thing this document is most likely about: same serial, else same maker + model. */
export function matchThing<T extends { id: string; serial_no: string | null; model_no: string | null; manufacturer: string | null }>(
  doc: ThingDoc,
  things: T[],
): T | null {
  const serial = norm(doc.serial);
  if (serial.length >= 4) {
    const bySerial = things.find((a) => norm(a.serial_no) === serial);
    if (bySerial) return bySerial;
  }
  const model = norm(doc.model);
  if (model.length >= 3) {
    const byModel = things.filter((a) => norm(a.model_no) === model && (!doc.maker || !a.manufacturer || norm(a.manufacturer) === norm(doc.maker)));
    if (byModel.length === 1) return byModel[0]!;
  }
  return null;
}
