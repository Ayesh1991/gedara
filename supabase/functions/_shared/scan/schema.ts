// JSON from the claude.ai "Bill Scanner" project (docs/bill-scanner-project.md): bills, warranty
// cards and appliance rating plates. Shared by the drive-scan Edge Function (Deno maps `zod` to
// npm:zod in its deno.json) and the web app (`@scan/schema`). External JSON is never trusted
// (CLAUDE.md rule 6): the text is sniffed before parsing and every document goes through Zod.
// Bills also accept ledger v7's aliases (store / quantity / price / item total) so older files import.
import { z } from 'zod';
import { billFingerprint } from './fingerprint.ts';

const num = z.number().finite();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const text = (max: number) => z.string().max(max).nullish();

const ItemSchema = z.object({
  name: text(200),
  category: text(40),
  subcategory: text(60),
  qty: num.nullish(),
  quantity: num.nullish(),
  unit: text(24),
  unit_price: num.nullish(),
  price: num.nullish(),
  amount: num.nullish(),
  total: num.nullish(),
  // EAN printed on the bill, when the scanner saw one (matches the product's barcode).
  barcode: z.union([z.string().regex(/^[0-9A-Za-z._-]{4,64}$/), num.int().nonnegative()]).nullish(),
});

export const ScannedBillSchema = z
  .object({
    doc_type: z.literal('bill').nullish(),
    shop: text(120),
    store: text(120),
    branch: text(120),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'date must be YYYY-MM-DD'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/, 'time must be HH:MM').nullish(),
    // Kept exactly as scanned (string, or a number if the scanner dropped the quotes): it is part
    // of the fingerprint.
    invoice_no: z.union([z.string().max(60), num]).nullish(),
    currency: text(8),
    payment_method: text(60),
    items: z.array(ItemSchema).min(1, 'a bill needs at least one item').max(300),
    sub_total: num.nullish(),
    discount: num.nullish(),
    rounding: num.nullish(),
    total: num.nullish(),
    notes: text(2000),
  })
  .refine((b) => !b.currency || b.currency.toUpperCase() === 'LKR', { message: 'only LKR bills can be imported' });

export type ScannedBill = z.infer<typeof ScannedBillSchema>;

/** A warranty card: what, from whom, until when. */
export const WarrantySchema = z.object({
  doc_type: z.literal('warranty'),
  product: text(120),
  maker: text(80),
  model: text(80),
  serial: text(80),
  shop: text(120),
  invoice_no: z.union([z.string().max(60), num]).nullish(),
  purchase_date: day.nullish(),
  warranty_months: num.int().min(0).max(600).nullish(),
  warranty_until: day.nullish(),
  lifetime: z.boolean().nullish(),
  price: num.nonnegative().nullish(),
  notes: text(2000),
});
export type WarrantyDoc = z.infer<typeof WarrantySchema>;

/** The sticker on the back of an appliance. */
export const RatingPlateSchema = z.object({
  doc_type: z.literal('rating_plate'),
  product: text(120),
  maker: text(80),
  model: text(80),
  serial: text(80),
  manufactured: z.string().regex(/^\d{4}(-\d{2}){0,2}$/).nullish(),
  power_w: num.nonnegative().nullish(),
  voltage: text(40),
  frequency_hz: num.nonnegative().nullish(),
  current_a: num.nonnegative().nullish(),
  capacity: text(40),
  energy_rating: text(40),
  refrigerant: text(40),
  country: text(60),
  notes: text(2000),
});
export type RatingPlateDoc = z.infer<typeof RatingPlateSchema>;

export type ThingDoc = WarrantyDoc | RatingPlateDoc;
export type DocType = 'bill' | 'warranty' | 'rating_plate';

export type BillParseError =
  | { kind: 'empty' }
  | { kind: 'html' }
  | { kind: 'json'; message: string }
  | { kind: 'shape'; index: number; message: string };

export type ScanParse =
  | { kind: 'bill'; bills: ScannedBill[] }
  | { kind: 'warranty' | 'rating_plate'; docs: ThingDoc[] }
  | { error: BillParseError };

/** The ```json fence, BOM, HTML (a Google Doc saved as a web page) — then JSON.parse. */
function readJson(input: string): { raw: unknown } | { error: BillParseError } {
  let t = input.replace(/^﻿/, '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  if (!t) return { error: { kind: 'empty' } };
  if (t.startsWith('<')) return { error: { kind: 'html' } };
  if (!t.startsWith('{') && !t.startsWith('[')) return { error: { kind: 'json', message: 'not JSON' } };
  try {
    return { raw: JSON.parse(t) };
  } catch (e) {
    return { error: { kind: 'json', message: (e as Error).message } };
  }
}

function firstIssue(index: number, error: z.ZodError): { error: BillParseError } {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { error: { kind: 'shape', index, message: where + (issue?.message ?? 'invalid document') } };
}

/**
 * A scanner file → bills, or warranty cards / rating plates. One document or an array; all of one
 * kind (a mixed file is refused so nothing is half-imported).
 */
export function parseScanText(input: string): ScanParse {
  const read = readJson(input);
  if ('error' in read) return read;
  const list = Array.isArray(read.raw) ? read.raw : [read.raw];
  if (list.length === 0) return { error: { kind: 'empty' } };
  if (list.length > 200) return { error: { kind: 'shape', index: 200, message: 'at most 200 documents at a time' } };

  const typeOf = (d: unknown) => (d && typeof d === 'object' ? (d as { doc_type?: unknown }).doc_type : undefined);
  const first = typeOf(list[0]);
  if (first === 'warranty' || first === 'rating_plate') {
    const schema = first === 'warranty' ? WarrantySchema : RatingPlateSchema;
    const docs: ThingDoc[] = [];
    for (const [index, d] of list.entries()) {
      if (typeOf(d) !== first) return { error: { kind: 'shape', index, message: 'doc_type: all documents in a file must be the same kind' } };
      const r = schema.safeParse(d);
      if (!r.success) return firstIssue(index, r.error);
      docs.push(r.data);
    }
    return { kind: first, docs };
  }

  const bills: ScannedBill[] = [];
  for (const [index, b] of list.entries()) {
    const r = ScannedBillSchema.safeParse(b);
    if (!r.success) return firstIssue(index, r.error);
    bills.push(r.data);
  }
  return { kind: 'bill', bills };
}

/** Bills only (Money › Import): a warranty / plate file is a shape error here. */
export function parseBillText(input: string): { bills: ScannedBill[] } | { error: BillParseError } {
  const r = parseScanText(input);
  if ('error' in r) return r;
  if (r.kind !== 'bill') return { error: { kind: 'shape', index: 0, message: `doc_type: this is a ${r.kind.replace('_', ' ')}, not a bill` } };
  return { bills: r.bills };
}

/** The bill's ledger-v7 fingerprint `b<hash>` (the same id Money › Import gives it). */
export function scannedBillFingerprint(bill: ScannedBill): string {
  return billFingerprint({
    invoice_no: bill.invoice_no as string | null | undefined,
    date: bill.date,
    time: bill.time,
    shop: bill.shop || bill.store || '',
    total: bill.total,
  });
}
