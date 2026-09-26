import { describe, expect, it } from 'vitest';
import { parseBillText, parseScanText, scannedBillFingerprint } from './billSchema';
import { billFingerprint } from './fingerprint';

const bill = { shop: 'Keells', date: '2026-09-20', time: '10:05', invoice_no: 'A12', total: 450, items: [{ name: 'Milk', amount: 450 }] };

describe('parseScanText', () => {
  it('reads bills (one or many) with the ledger-v7 fingerprint', () => {
    const r = parseScanText(JSON.stringify([bill, { ...bill, invoice_no: 'A13' }]));
    expect('kind' in r && r.kind).toBe('bill');
    if (!('kind' in r) || r.kind !== 'bill') return;
    expect(scannedBillFingerprint(r.bills[0]!)).toBe(
      billFingerprint({ invoice_no: 'A12', date: '2026-09-20', time: '10:05', shop: 'Keells', total: 450 }),
    );
  });

  it('reads a warranty card', () => {
    const r = parseScanText(
      '```json\n{"doc_type":"warranty","maker":"LG","model":"GL-B201","serial":"SN123","purchase_date":"2026-05-01","warranty_months":24,"shop":"Singer"}\n```',
    );
    expect(r).toMatchObject({ kind: 'warranty', docs: [{ maker: 'LG', warranty_months: 24 }] });
  });

  it('reads a rating plate', () => {
    const r = parseScanText('{"doc_type":"rating_plate","maker":"Samsung","model":"RT28","power_w":150,"manufactured":"2025-11"}');
    expect(r).toMatchObject({ kind: 'rating_plate', docs: [{ power_w: 150 }] });
  });

  it('refuses a mixed file and bad dates', () => {
    expect(parseScanText(JSON.stringify([{ doc_type: 'warranty' }, { doc_type: 'rating_plate' }]))).toMatchObject({
      error: { kind: 'shape', index: 1 },
    });
    expect(parseScanText('{"doc_type":"warranty","warranty_until":"12/05/2027"}')).toMatchObject({ error: { kind: 'shape' } });
  });

  it('Money › Import only takes bills', () => {
    expect(parseBillText('{"doc_type":"warranty","maker":"LG"}')).toMatchObject({ error: { kind: 'shape' } });
    expect(parseBillText(JSON.stringify(bill))).toMatchObject({ bills: [{ shop: 'Keells' }] });
  });

  it('a Google Doc exported as text is just JSON text', () => {
    expect(parseScanText('﻿  ' + JSON.stringify(bill) + '\n')).toMatchObject({ kind: 'bill' });
    expect(parseScanText('<html><body>{}</body></html>')).toEqual({ error: { kind: 'html' } });
  });
});
