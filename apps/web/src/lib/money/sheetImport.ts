// Ledger Google-Sheet CSV (File → Download → CSV) → bills for rpc_import_bills.
// Columns: id,date,time,shop,category,subcategory,item,qty,unit,unit_price,amount,paid_by,notes,source,synced_at
//
// Row ids decide the fingerprints (CLAUDE.md rule 5), so re-importing is always harmless:
//   b<hash>-<idx>-<hash>  ledger v7 bill line → bill fingerprint = the prefix, line = the id as stored
//   13-char base36 uid    older rows (random ids) → grouped into bills, `L<hash(row ids)>`
//   TEST-…                the Sheet's editor test rows → skipped
// A whole older upload that repeats an earlier one (same bill, same lines, uploaded again) is
// skipped as a duplicate; identical items inside one bill are real and kept.
import Papa from 'papaparse';
import { z } from 'zod';
import { legacyFingerprint, parseLineId } from './fingerprint';
import { sumAmounts } from './format';
import { padTime, type ImportBill, type ImportLine } from './billSchema';
import { pickCategory, SHEET_NAME_TO_KEY, type CategoryRow } from './categoriesMap';

const cell = z.string().transform((s) => s.trim());
const optNum = cell.transform((s, ctx) => {
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${s}` });
    return z.NEVER;
  }
  return n;
});

export const SheetRowSchema = z.object({
  id: cell.pipe(z.string().min(1).max(80)),
  date: cell.pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')),
  time: cell,
  shop: cell,
  category: cell,
  subcategory: cell,
  item: cell,
  qty: optNum,
  unit: cell,
  unit_price: optNum,
  amount: optNum.pipe(z.number()),
  paid_by: cell,
  notes: cell,
  source: cell,
});
export type SheetRow = z.infer<typeof SheetRowSchema>;

export const SHEET_COLUMNS = [
  'id', 'date', 'time', 'shop', 'category', 'subcategory', 'item', 'qty', 'unit', 'unit_price', 'amount',
  'paid_by', 'notes', 'source',
] as const;

export type SkipReason = 'test' | 'duplicateUpload';

export interface SkippedRow {
  id: string;
  date: string;
  item: string;
  amount: number;
  reason: SkipReason;
}

export interface SheetBill {
  fingerprint: string;
  date: string;
  time: string | null;
  shop: string;
  paidBy: string;
  invoiceNo: string | null;
  source: string;
  rows: SheetRow[];
}

export interface SheetParse {
  rowsRead: number;
  bills: SheetBill[];
  skipped: SkippedRow[];
  /** Sum of every row's amount in the file (including skipped rows). */
  sheetTotal: number;
  paidByValues: string[];
}

export type SheetParseError = { kind: 'columns'; missing: string[] } | { kind: 'row'; line: number; message: string };

const UID_RE = /^[0-9a-z]{12,14}$/;
const UPLOAD_GAP_MS = 5000;

function uidTime(id: string): number {
  return parseInt(id.slice(0, 8), 36);
}

function invoiceFromNotes(notes: string): string | null {
  const m = /^invoice\s+(.+)$/i.exec(notes.trim());
  return m ? m[1]!.trim() : null;
}

export function parseSheetCsv(text: string): SheetParse | { error: SheetParseError } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const fields = parsed.meta.fields ?? [];
  const missing = SHEET_COLUMNS.filter((c) => !fields.includes(c));
  if (missing.length) return { error: { kind: 'columns', missing } };

  const rows: SheetRow[] = [];
  for (const [i, raw] of parsed.data.entries()) {
    const r = SheetRowSchema.safeParse(raw);
    if (!r.success) {
      const issue = r.error.issues[0];
      return { error: { kind: 'row', line: i + 2, message: `${issue?.path.join('.')}: ${issue?.message}` } };
    }
    rows.push(r.data);
  }

  const skipped: SkippedRow[] = [];
  const skip = (r: SheetRow, reason: SkipReason) =>
    skipped.push({ id: r.id, date: r.date, item: r.item, amount: r.amount, reason });

  const v7 = new Map<string, SheetRow[]>();
  const legacy = new Map<string, SheetRow[]>();
  for (const r of rows) {
    if (r.id.startsWith('TEST-') || r.source.toLowerCase() === 'test') {
      skip(r, 'test');
      continue;
    }
    const line = parseLineId(r.id);
    if (line) {
      const list = v7.get(line.bill) ?? [];
      list.push(r);
      v7.set(line.bill, list);
      continue;
    }
    // Older rows: one bill = same date, time, shop, invoice note, payment and source.
    const key = [r.date, padTime(r.time) ?? '', r.shop.toLowerCase(), r.notes, r.paid_by, r.source].join('|');
    const list = legacy.get(key) ?? [];
    list.push(r);
    legacy.set(key, list);
  }

  const bills: SheetBill[] = [];
  const makeBill = (fingerprint: string, list: SheetRow[]): SheetBill => {
    const first = list[0]!;
    return {
      fingerprint,
      date: first.date,
      time: padTime(first.time),
      shop: first.shop,
      paidBy: first.paid_by,
      invoiceNo: invoiceFromNotes(first.notes),
      source: first.source,
      rows: list,
    };
  };

  for (const [fp, list] of v7) {
    list.sort((a, b) => parseLineId(a.id)!.idx - parseLineId(b.id)!.idx);
    bills.push(makeBill(fp, list));
  }

  for (const list of legacy.values()) {
    // Split into upload batches: ids are Date.now() in base36 + random, so one upload's ids sit
    // within a few ms of each other.
    const ordered = [...list].sort((a, b) => (UID_RE.test(a.id) ? uidTime(a.id) : 0) - (UID_RE.test(b.id) ? uidTime(b.id) : 0));
    const batches: SheetRow[][] = [];
    let last = -Infinity;
    for (const r of ordered) {
      const t = UID_RE.test(r.id) ? uidTime(r.id) : last;
      if (!batches.length || t - last > UPLOAD_GAP_MS) batches.push([]);
      batches.at(-1)!.push(r);
      last = t;
    }
    const seen = new Set<string>();
    for (const batch of batches) {
      const signature = batch
        .map((r) => [r.item.toLowerCase(), r.qty ?? '', r.amount.toFixed(2)].join('|'))
        .sort()
        .join('\n');
      if (seen.has(signature)) {
        for (const r of batch) skip(r, 'duplicateUpload');
        continue;
      }
      seen.add(signature);
      bills.push(makeBill(legacyFingerprint(batch.map((r) => r.id)), batch));
    }
  }

  bills.sort((a, b) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? '')));
  return {
    rowsRead: rows.length,
    bills,
    skipped,
    sheetTotal: sumAmounts(rows.map((r) => r.amount)),
    paidByValues: [...new Set(bills.map((b) => b.paidBy))].sort(),
  };
}

/** Sheet bill → rpc_import_bills payload. `accountFor` maps the Sheet's paid_by to an account id. */
export function sheetBillToImport(
  bill: SheetBill,
  categories: CategoryRow[],
  accountFor: (paidBy: string) => string,
): ImportBill {
  const isV7 = bill.fingerprint.startsWith('b');
  const lines: ImportLine[] = bill.rows.map((r, i) => {
    const key = SHEET_NAME_TO_KEY[r.category] ?? 'other';
    const pick = pickCategory(categories, key, r.item, r.subcategory);
    return {
      line_no: isV7 ? parseLineId(r.id)!.idx : i,
      raw_name: r.item || r.subcategory || 'item',
      category_id: pick.categoryId,
      qty: r.qty,
      unit_text: r.unit || null,
      unit_price: r.unit_price,
      amount: r.amount,
      fingerprint: r.id,
      guessed: !pick.exact,
    };
  });
  const extra = bill.paidBy && !/^(cash|card)$/i.test(bill.paidBy) ? `Paid: ${bill.paidBy}` : null;
  return {
    type: 'expense',
    account_id: accountFor(bill.paidBy),
    payee_text: bill.shop || null,
    occurred_on: bill.date,
    occurred_at: bill.time,
    invoice_no: bill.invoiceNo,
    subtotal: null,
    discount: 0,
    total: sumAmounts(lines.map((l) => l.amount)),
    source: 'import_sheet',
    fingerprint: bill.fingerprint,
    notes: [bill.source === 'manual' ? 'Entered by hand in ledger v7' : null, extra].filter(Boolean).join(' · ') || null,
    lines,
  };
}

/** Per-month totals of the rows that will be imported, and of those skipped. */
export function monthTotals(p: SheetParse): Array<{ month: string; imported: number; skipped: number }> {
  const months = new Map<string, { imported: number[]; skipped: number[] }>();
  const at = (m: string) => {
    let v = months.get(m);
    if (!v) months.set(m, (v = { imported: [], skipped: [] }));
    return v;
  };
  for (const b of p.bills) for (const r of b.rows) at(r.date.slice(0, 7)).imported.push(r.amount);
  for (const s of p.skipped) at(s.date.slice(0, 7)).skipped.push(s.amount);
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, imported: sumAmounts(v.imported), skipped: sumAmounts(v.skipped) }));
}
