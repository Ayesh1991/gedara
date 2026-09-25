// Bill-scanner JSON (reference/bill-scanner/samples/prompt.md) → validated bills → rpc_import_bills
// payloads. External JSON is never trusted (CLAUDE.md rule 6): the text is sniffed before parsing,
// every bill goes through Zod, and ledger v7's tolerated aliases (store / quantity / price / item
// total) are accepted so older files still import.
import { z } from 'zod';
import { billFingerprint, lineFingerprint } from './fingerprint';
import { sumAmounts, toCents } from './format';
import { guessTopKey, pickCategory, type CategoryRow } from './categoriesMap';
import type { RpcRoute } from '../spine/route';

const num = z.number().finite();

const ItemSchema = z.object({
  name: z.string().max(200).nullish(),
  category: z.string().max(40).nullish(),
  subcategory: z.string().max(60).nullish(),
  qty: num.nullish(),
  quantity: num.nullish(),
  unit: z.string().max(24).nullish(),
  unit_price: num.nullish(),
  price: num.nullish(),
  amount: num.nullish(),
  total: num.nullish(),
  // EAN printed on the bill, when the scanner saw one (matches the product's barcode).
  barcode: z.union([z.string().regex(/^[0-9A-Za-z._-]{4,64}$/), num.int().nonnegative()]).nullish(),
});

export const ScannedBillSchema = z
  .object({
    shop: z.string().max(120).nullish(),
    store: z.string().max(120).nullish(),
    branch: z.string().max(120).nullish(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'date must be YYYY-MM-DD'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/, 'time must be HH:MM').nullish(),
    // Kept exactly as scanned (string, or a number if the scanner dropped the quotes): it is part
    // of the fingerprint.
    invoice_no: z.union([z.string().max(60), num]).nullish(),
    currency: z.string().max(8).nullish(),
    payment_method: z.string().max(60).nullish(),
    items: z.array(ItemSchema).min(1, 'a bill needs at least one item').max(300),
    sub_total: num.nullish(),
    discount: num.nullish(),
    rounding: num.nullish(),
    total: num.nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((b) => !b.currency || b.currency.toUpperCase() === 'LKR', { message: 'only LKR bills can be imported' });

export type ScannedBill = z.infer<typeof ScannedBillSchema>;

export type BillParseError =
  | { kind: 'empty' }
  | { kind: 'html' }
  | { kind: 'json'; message: string }
  | { kind: 'shape'; index: number; message: string };

/**
 * Text (pasted, or a file's contents) → bills. Accepts one bill, an array of bills, and JSON wrapped
 * in a ```json fence. Rejects HTML (e.g. a Google Doc saved where a .json file was expected).
 */
export function parseBillText(text: string): { bills: ScannedBill[] } | { error: BillParseError } {
  let t = text.replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  if (!t) return { error: { kind: 'empty' } };
  if (t.startsWith('<')) return { error: { kind: 'html' } };
  if (!t.startsWith('{') && !t.startsWith('[')) return { error: { kind: 'json', message: 'not JSON' } };
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    return { error: { kind: 'json', message: (e as Error).message } };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return { error: { kind: 'empty' } };
  if (list.length > 200) return { error: { kind: 'shape', index: 200, message: 'at most 200 bills at a time' } };
  const bills: ScannedBill[] = [];
  for (const [index, b] of list.entries()) {
    const r = ScannedBillSchema.safeParse(b);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return { error: { kind: 'shape', index, message: where + (issue?.message ?? 'invalid bill') } };
    }
    bills.push(r.data);
  }
  return { bills };
}

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
  const fp = billFingerprint({
    invoice_no: bill.invoice_no as string | null | undefined,
    date: bill.date,
    time: bill.time,
    shop,
    total: bill.total,
  });
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
