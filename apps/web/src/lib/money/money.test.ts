import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { billFingerprint, hash32, legacyFingerprint, lineFingerprint, manualFingerprint, parseLineId } from './fingerprint';
import { formatLKR, parseAmount, sumAmounts } from './format';
import { padTime, parseBillText, scannedToImport, type ScannedBill } from './billSchema';
import { monthTotals, parseSheetCsv, sheetBillToImport, type SheetParse } from './sheetImport';
import { pickCategory, type CategoryRow } from './categoriesMap';

// Read-only inputs (never shipped): the real Sheet export and bill-scanner samples.
const REF = fileURLToPath(new URL('../../../../../reference/', import.meta.url));
const csv = readFileSync(`${REF}sheet-export/ledger.csv`, 'utf8');
const SAMPLES = `${REF}bill-scanner/samples/`;
const sample = (name: string) => readFileSync(SAMPLES + name, 'utf8');

// A small household taxonomy shaped like the seed.
const CATS: CategoryRow[] = [
  { id: 'g', parent_id: null, key: 'grocery', name: 'Grocery', kind: 'expense', sort: 1, archived: false },
  { id: 'g-rice', parent_id: 'g', key: null, name: 'Rice', kind: 'expense', sort: 1, archived: false },
  { id: 'g-veg', parent_id: 'g', key: null, name: 'Vegetables', kind: 'expense', sort: 6, archived: false },
  { id: 'g-dairy', parent_id: 'g', key: null, name: 'Dairy & milk', kind: 'expense', sort: 11, archived: false },
  { id: 'g-other', parent_id: 'g', key: null, name: 'Other grocery', kind: 'expense', sort: 17, archived: false },
  { id: 'c', parent_id: null, key: 'consumable', name: 'Consumables', kind: 'expense', sort: 2, archived: false },
  { id: 'c-clean', parent_id: 'c', key: null, name: 'Cleaning & detergents', kind: 'expense', sort: 3, archived: false },
  { id: 'c-other', parent_id: 'c', key: null, name: 'Other consumable', kind: 'expense', sort: 9, archived: false },
  { id: 'o', parent_id: null, key: 'other', name: 'Other', kind: 'expense', sort: 9, archived: false },
  { id: 'o-misc', parent_id: 'o', key: null, name: 'Miscellaneous', kind: 'expense', sort: 3, archived: false },
];

function sheet(): SheetParse {
  const p = parseSheetCsv(csv);
  if ('error' in p) throw new Error(JSON.stringify(p.error));
  return p;
}

describe('ledger v7 fingerprints', () => {
  it('hash32 reproduces known ledger ids', () => {
    expect('b' + hash32('100000107|2026-07-03|13:26|lady j|7160')).toBe('b1yyq4jo');
    expect('b' + hash32('|2026-07-03|10:48|pickme|313.82')).toBe('b1g6yo0i');
    expect(hash32('Money Plant M|390')).toBe('n90mr5');
  });

  it('every v7 line id in the Sheet is rebuilt exactly from its row', () => {
    const rows = sheet().bills.flatMap((b) => b.rows).filter((r) => parseLineId(r.id));
    expect(rows).toHaveLength(240);
    for (const r of rows) {
      const { bill, idx } = parseLineId(r.id)!;
      expect(lineFingerprint(bill, idx, r.item, r.amount)).toBe(r.id);
    }
  });

  it('bill ids of the scanner samples match the v7 formula', () => {
    const expected: Record<string, string> = {
      'bill_2026-08-10_tasty_caterers.json': 'bz16d1j',
      'bill_2026-08-22_cargills_food_city.json': 'b1ob3kse',
      'bill_2026-08-22_lakshmi_sarubala.json': 'b9je0dr',
      'bill_2026-08-22_sahana_vegemart.json': 'b10m6ckg',
      'bill_2026-08-22_shoe_fair.json': 'bq5z6jp',
    };
    const files = readdirSync(SAMPLES).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(Object.keys(expected).sort());
    for (const f of files) {
      const b = JSON.parse(sample(f)) as ScannedBill;
      expect(billFingerprint({ ...b, invoice_no: b.invoice_no as string, shop: b.shop })).toBe(expected[f]);
    }
  });

  it('manual and legacy fingerprints are deterministic and DB-safe', () => {
    const p = { type: 'expense', date: '2026-09-24', time: '08:10', accountId: 'acc', payee: ' Keells ', total: 1250 };
    expect(manualFingerprint(p)).toBe(manualFingerprint({ ...p, payee: 'keells' }));
    expect(manualFingerprint(p, 2)).toBe(manualFingerprint(p) + '~2');
    expect(manualFingerprint(p)).toMatch(/^m[0-9a-z]+$/);
    expect(legacyFingerprint(['b', 'a'])).toBe(legacyFingerprint(['a', 'b']));
  });
});

describe('Sheet CSV import', () => {
  it('reads every row and groups them into bills', () => {
    const p = sheet();
    expect(p.rowsRead).toBe(308);
    expect(p.bills.filter((b) => b.fingerprint.startsWith('b'))).toHaveLength(60);
    expect(p.bills.every((b) => /^[bL][0-9a-z]+$/.test(b.fingerprint))).toBe(true);
    expect(new Set(p.bills.map((b) => b.fingerprint)).size).toBe(p.bills.length);
    expect(p.paidByValues).toEqual(['bank transfer', 'card', 'cash', 'cash + loyalty points', 'online']);
  });

  it('skips the test rows and the second upload of Invoice 299, nothing else', () => {
    const p = sheet();
    expect(p.skipped.filter((s) => s.reason === 'test').map((s) => s.id)).toEqual([
      'TEST-1782990687582',
      'TEST-1782991919606',
    ]);
    const dup = p.skipped.filter((s) => s.reason === 'duplicateUpload');
    expect(dup).toHaveLength(2);
    expect(dup.every((s) => s.date === '2026-06-27')).toBe(true);
    expect(sumAmounts(dup.map((s) => s.amount))).toBe(595);
  });

  it('totals reconcile with the Sheet to the rupee', () => {
    const p = sheet();
    expect(p.sheetTotal).toBe(204613.61);
    const imported = sumAmounts(p.bills.flatMap((b) => b.rows.map((r) => r.amount)));
    const skipped = sumAmounts(p.skipped.map((s) => s.amount));
    expect(imported).toBe(204018.61);
    expect(sumAmounts([imported, skipped])).toBe(p.sheetTotal);
    expect(monthTotals(p)).toEqual([
      { month: '2026-05', imported: 431, skipped: 0 },
      { month: '2026-06', imported: 18678.17, skipped: 595 },
      { month: '2026-07', imported: 104134.01, skipped: 0 },
      { month: '2026-08', imported: 80775.43, skipped: 0 },
    ]);
  });

  it('builds RPC payloads whose lines add up and keep the Sheet ids', () => {
    const p = sheet();
    for (const b of p.bills) {
      const bill = sheetBillToImport(b, CATS, () => 'acc');
      expect(bill.total).toBe(sumAmounts(bill.lines.map((l) => l.amount)));
      expect(bill.lines.map((l) => l.fingerprint)).toEqual(b.rows.map((r) => r.id));
      expect(new Set(bill.lines.map((l) => l.line_no)).size).toBe(bill.lines.length);
      expect(bill.occurred_at === null || /^\d{2}:\d{2}$/.test(bill.occurred_at)).toBe(true);
    }
  });

  it('rejects a file without the ledger columns', () => {
    expect(parseSheetCsv('a,b\n1,2')).toEqual({ error: expect.objectContaining({ kind: 'columns' }) });
  });
});

describe('bill scanner JSON', () => {
  it('accepts a sample, an array, and a ```json fence', () => {
    const one = sample('bill_2026-08-22_cargills_food_city.json');
    expect(parseBillText(one)).toMatchObject({ bills: [{ shop: 'CARGILLS FOOD CITY' }] });
    expect(parseBillText(`[${one},${one}]`)).toMatchObject({ bills: [{}, {}] });
    expect(parseBillText('```json\n' + one + '\n```')).toMatchObject({ bills: [{}] });
  });

  it('rejects HTML (a Google Doc), non-JSON and bad shapes', () => {
    expect(parseBillText('<html><body>{}</body></html>')).toEqual({ error: { kind: 'html' } });
    expect(parseBillText('hello')).toMatchObject({ error: { kind: 'json' } });
    expect(parseBillText('{"shop":"x","date":"yesterday","items":[{"name":"a","amount":1}]}')).toMatchObject({
      error: { kind: 'shape', index: 0 },
    });
    expect(parseBillText('{"shop":"x","date":"2026-01-01","currency":"USD","items":[{"amount":1}]}')).toMatchObject({
      error: { kind: 'shape' },
    });
  });

  it('turns a bill into lines that add up, with v7 fingerprints', () => {
    const [b] = (parseBillText(sample('bill_2026-08-22_cargills_food_city.json')) as { bills: ScannedBill[] }).bills;
    const bill = scannedToImport(b!, CATS, 'card');
    expect(bill.fingerprint).toBe('b1ob3kse');
    expect(bill.lines).toHaveLength(10);
    expect(bill.total).toBe(4620);
    expect(sumAmounts(bill.lines.map((l) => l.amount))).toBe(4620);
    expect(bill.lines[0]!.fingerprint).toBe(lineFingerprint('b1ob3kse', 0, 'Bic Twin Lady Razor', 320));
    expect(bill.occurred_at).toBe('20:20');
  });

  it('adds one line for a discount so every rupee lives in a line', () => {
    const bill = scannedToImport(
      {
        shop: 'Keells',
        date: '2026-09-01',
        time: '9:05',
        total: 1080,
        discount: 120,
        items: [{ name: 'Ambewela Butter', category: 'grocery', subcategory: 'Dairy & milk', amount: 1200 }],
      },
      CATS,
      'cash',
    );
    expect(bill.lines).toHaveLength(2);
    expect(bill.lines[1]).toMatchObject({ amount: -120, category_id: 'g-dairy', synthetic: true, line_no: 1 });
    expect(bill.occurred_at).toBe('09:05');
  });
});

describe('categories, units, money', () => {
  it('maps scanner sub-categories, falling back like ledger v7', () => {
    expect(pickCategory(CATS, 'grocery', 'Keeri Samba', 'Rice')).toEqual({ categoryId: 'g-rice', exact: true });
    expect(pickCategory(CATS, 'grocery', 'Kist Mayonnaise', 'Condiments & sauces')).toEqual({
      categoryId: 'g-other',
      exact: false,
    });
    expect(pickCategory(CATS, 'consumable', 'garbage bag', null)).toEqual({ categoryId: 'c-clean', exact: true });
  });

  it('formats and parses LKR', () => {
    expect(formatLKR(4620)).toContain('4,620.00');
    expect(parseAmount('4,620')).toBe(4620);
    expect(parseAmount('Rs 1 250.5')).toBe(1250.5);
    expect(parseAmount('12.345')).toBeNull();
    expect(sumAmounts([0.1, 0.2])).toBe(0.3);
    expect(padTime('9:17')).toBe('09:17');
  });
});
