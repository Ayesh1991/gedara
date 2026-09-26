// Bill-scanner JSON → validated bills → rpc_import_bills payloads. The Zod schemas, the text
// sniffing and the fingerprints are shared with the drive-scan Edge Function (@scan), so a bill
// read from Drive and the same bill pasted here get the same id.
import { scannedBillFingerprint, type ScannedBill } from '@scan/schema.ts';
import { lineFingerprint } from './fingerprint';
import { sumAmounts, toCents } from './format';
import { guessTopKey, pickCategory, type CategoryRow } from './categoriesMap';
import type { RpcRoute } from '../spine/route';

export {
  ScannedBillSchema,
  parseBillText,
  parseScanText,
  scannedBillFingerprint,
  type BillParseError,
  type RatingPlateDoc,
  type ScanParse,
  type ScannedBill,
  type ThingDoc,
  type WarrantyDoc,
} from '@scan/schema.ts';

/** Files: trust the content, not the name; allow the MIME types a .json can arrive with. */
export const BILL_FILE_TYPES = ['application/json', 'text/json', 'text/plain', ''];

export function padTime(t: string | null | undefined): string | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

export interface ImportLine {
  line_no: number;
  raw_name: string;
  category_id: string | null;
  qty: number | null;
  unit_text: string | null;
  unit_price: number | null;
  amount: number;
  fingerprint: string;
  /** Preview only: the scanner's sub-category wasn't found, so a fallback was used. */
  guessed?: boolean;
  /** Preview only: added so the lines add up to the bill total. */
  synthetic?: boolean;
  /** Preview only: the scanner printed no unit (unit_text fell back to 'pcs'). */
  unitMissing?: boolean;
  /** Preview only: the barcode printed on the bill. */
  barcode?: string | null;
  /** Where the line goes (Phase 4); absent = the category's default, nothing created. */
  route?: RpcRoute;
}

export interface ImportBill {
  type: 'expense';
  account_id: string;
  payee_text: string | null;
  occurred_on: string;
  occurred_at: string | null;
  invoice_no: string | null;
  subtotal: number | null;
  discount: number;
  total: number;
  source: 'scan' | 'import_sheet';
  fingerprint: string;
  notes: string | null;
  lines: ImportLine[];
  /** Free-text shopping-list items bought on this bill. */
  tick_item_ids?: string[];
}

/** One scanned bill → an rpc_import_bills payload with ledger-v7 fingerprints. */
export function scannedToImport(bill: ScannedBill, categories: CategoryRow[], accountId: string): ImportBill {
  const shop = bill.shop || bill.store || '';
  const fp = scannedBillFingerprint(bill);
  const lines: ImportLine[] = bill.items.map((it, idx) => {
    const rawAmount = it.amount ?? it.total ?? 0;
    const key = guessTopKey(it.name, it.category);
    const pick = pickCategory(categories, key, it.name, it.subcategory);
    return {
      line_no: idx,
      raw_name: (it.name || '').trim() || 'item',
      category_id: pick.categoryId,
      qty: it.qty ?? it.quantity ?? null,
      unit_text: it.unit || 'pcs',
      unit_price: it.unit_price ?? it.price ?? null,
      amount: rawAmount,
      fingerprint: lineFingerprint(fp, idx, it.name, rawAmount),
      guessed: !pick.exact,
      unitMissing: !it.unit,
      barcode: it.barcode == null || it.barcode === '' ? null : String(it.barcode),
    };
  });

  const linesSum = sumAmounts(lines.map((l) => l.amount));
  const total = bill.total ?? linesSum;
  const gap = (toCents(total) - toCents(linesSum)) / 100;
  if (gap !== 0) {
    // Every rupee lives in a line: the difference (discount, rounding, service charge, VAT) becomes
    // one more line, in the category of the biggest line.
    const biggest = lines.reduce((a, b) => (b.amount > a.amount ? b : a), lines[0]!);
    const name = gap < 0 ? 'Bill discount / rounding' : 'Charges / taxes / rounding';
    const idx = lines.length;
    lines.push({
      line_no: idx,
      raw_name: name,
      category_id: biggest.category_id,
      qty: null,
      unit_text: null,
      unit_price: null,
      amount: gap,
      fingerprint: lineFingerprint(fp, idx, name, gap),
      synthetic: true,
    });
  }

  const noteParts = [bill.branch ? `Branch: ${bill.branch}` : null, bill.notes || null].filter(Boolean);
  return {
    type: 'expense',
    account_id: accountId,
    payee_text: shop.trim() || null,
    occurred_on: bill.date.slice(0, 10),
    occurred_at: padTime(bill.time),
    invoice_no: bill.invoice_no == null || bill.invoice_no === '' ? null : String(bill.invoice_no),
    subtotal: bill.sub_total ?? null,
    discount: bill.discount ?? 0,
    total,
    source: 'scan',
    fingerprint: fp,
    notes: noteParts.join(' · ').slice(0, 2000) || null,
    lines,
  };
}

/** Strip preview-only fields before sending to the database. */
export function toRpcBill(b: ImportBill) {
  return { ...b, lines: b.lines.map(({ guessed: _g, synthetic: _s, unitMissing: _u, barcode: _b, ...l }) => l) };
}

export function paidByCard(method: string | null | undefined): boolean {
  return (method || '').toLowerCase().includes('card');
}
