import { describe, expect, it } from 'vitest';
import { formatBytes, sniffDocument } from '../fileTypes';
import { cleanCustom, displayValue, fieldKey, fieldsFor, type CategoryField } from './fields';
import {
  addDaysIso,
  assetTag,
  assetValue,
  daysBetween,
  monthsBetween,
  suggestedLifeMonths,
  warrantyState,
  type ValueInput,
} from './value';

const base: ValueInput = {
  purchase_price: 120000,
  purchased_on: '2024-01-15',
  useful_life_months: 60,
  salvage_value: 20000,
  status: 'in_use',
  sold_on: null,
  sold_price: null,
  maintenance_cost: 0,
};

describe('monthsBetween (like Postgres age())', () => {
  it('counts a month once its day is reached', () => {
    expect(monthsBetween('2026-01-15', '2026-02-14')).toBe(0);
    expect(monthsBetween('2026-01-15', '2026-02-15')).toBe(1);
    expect(monthsBetween('2026-01-31', '2026-02-28')).toBe(0);
    expect(monthsBetween('2026-01-31', '2026-03-31')).toBe(2);
    expect(monthsBetween('2020-09-25', '2026-09-25')).toBe(72);
  });
  it('never goes negative (bought in the future)', () => {
    expect(monthsBetween('2027-01-01', '2026-09-25')).toBe(0);
  });
  it('days and adding days', () => {
    expect(daysBetween('2026-09-20', '2027-03-19')).toBe(180);
    expect(daysBetween('2026-09-25', '2026-09-20')).toBe(-5);
    expect(addDaysIso('2026-09-20', 180)).toBe('2027-03-19');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('assetValue (straight-line, mirrors v_asset)', () => {
  it('depreciates towards the salvage value', () => {
    // 30 of 60 months: halfway from 120,000 to 20,000.
    const v = assetValue(base, '2026-07-15');
    expect(v.monthsOwned).toBe(30);
    expect(v.bookValue).toBe(70000);
    expect(v.currentValue).toBe(70000);
    expect(v.costOfOwnership).toBe(120000);
    expect(v.costPerMonth).toBe(4000);
  });
  it('stops at the salvage value after its useful life', () => {
    expect(assetValue(base, '2034-01-15').bookValue).toBe(20000);
  });
  it('is worth its price without a useful life, and nothing is known without a price', () => {
    expect(assetValue({ ...base, useful_life_months: null }, '2030-01-01').bookValue).toBe(120000);
    const unknown = assetValue({ ...base, purchase_price: null }, '2026-09-25');
    expect(unknown.bookValue).toBeNull();
    expect(unknown.costOfOwnership).toBeNull();
  });
  it('a salvage value above the price is capped at the price', () => {
    expect(assetValue({ ...base, salvage_value: 500000 }, '2034-01-15').bookValue).toBe(120000);
  });
  it('sold: worth nothing now, gain against book value on the sale day, sale reduces the cost', () => {
    const v = assetValue(
      { ...base, purchased_on: '2010-01-15', status: 'sold', sold_on: '2026-09-24', sold_price: 25000, maintenance_cost: 7500 },
      '2026-09-25',
    );
    expect(v.currentValue).toBe(0);
    expect(v.bookValue).toBe(20000);
    expect(v.saleGain).toBe(5000);
    expect(v.costOfOwnership).toBe(102500);
  });
  it('counts months only up to the day it was sold', () => {
    const v = assetValue({ ...base, status: 'sold', sold_on: '2025-01-15', sold_price: 1 }, '2026-09-25');
    expect(v.monthsOwned).toBe(12);
  });
  it('cost per month uses at least one month', () => {
    expect(assetValue({ ...base, purchased_on: '2026-09-20' }, '2026-09-25').costPerMonth).toBe(120000);
  });
});

describe('warrantyState', () => {
  const today = '2026-09-25';
  it('lifetime, none, active, ending within 30 days, expired', () => {
    expect(warrantyState({ lifetime_warranty: true, warranty_until: null }, today).state).toBe('lifetime');
    expect(warrantyState({ lifetime_warranty: false, warranty_until: null }, today).state).toBe('none');
    expect(warrantyState({ lifetime_warranty: false, warranty_until: '2028-09-01' }, today).state).toBe('active');
    expect(warrantyState({ lifetime_warranty: false, warranty_until: '2026-10-25' }, today)).toEqual({ state: 'ending', daysLeft: 30 });
    expect(warrantyState({ lifetime_warranty: false, warranty_until: '2026-09-25' }, today)).toEqual({ state: 'ending', daysLeft: 0 });
    expect(warrantyState({ lifetime_warranty: false, warranty_until: '2026-09-24' }, today).state).toBe('expired');
  });
});

describe('small helpers', () => {
  it('A-numbers', () => {
    expect(assetTag(1)).toBe('A-0001');
    expect(assetTag(42)).toBe('A-0042');
    expect(assetTag(12345)).toBe('A-12345');
    // The NIIMBOT 20 mm label holds one line of ≤ 10 characters.
    expect(assetTag(9999).length).toBeLessThanOrEqual(10);
  });
  it('useful-life suggestions by category name', () => {
    expect(suggestedLifeMonths('Electronics')).toBe(48);
    expect(suggestedLifeMonths('Home appliances')).toBe(96);
    expect(suggestedLifeMonths('Furniture')).toBe(120);
    expect(suggestedLifeMonths('Books')).toBeNull();
    expect(suggestedLifeMonths(null)).toBeNull();
  });
});

const F = (p: Partial<CategoryField> & Pick<CategoryField, 'key' | 'type' | 'category_id'>): CategoryField => ({
  id: p.key,
  label: p.key,
  options: null,
  sort: 0,
  ...p,
});

describe('category field templates', () => {
  const categories = [
    { id: 'top', parent_id: null },
    { id: 'elec', parent_id: 'top' },
    { id: 'other', parent_id: 'top' },
  ];
  const fields = [
    F({ key: 'imei', type: 'text', category_id: 'elec', sort: 1 }),
    F({ key: 'colour', type: 'text', category_id: 'top', sort: 1 }),
    F({ key: 'storage', type: 'text', category_id: 'elec', sort: 2 }),
    F({ key: 'colour', type: 'text', category_id: 'elec', sort: 3 }),
  ];
  it('parent fields first, then own; a key appears once', () => {
    expect(fieldsFor(fields, 'elec', categories).map((f) => `${f.category_id}:${f.key}`)).toEqual([
      'top:colour',
      'elec:imei',
      'elec:storage',
    ]);
    expect(fieldsFor(fields, 'other', categories).map((f) => f.key)).toEqual(['colour']);
    expect(fieldsFor(fields, null, categories)).toEqual([]);
  });

  it('keys from labels', () => {
    expect(fieldKey('Power (W)')).toBe('power_w');
    expect(fieldKey('  IMEI ')).toBe('imei');
    expect(fieldKey('2nd SIM')).toBe('f_2nd_sim');
  });

  it('cleans and types values; keeps values of other categories; reports bad ones', () => {
    const tpl = [
      F({ key: 'power_w', type: 'number', category_id: 'x' }),
      F({ key: 'bought_used', type: 'boolean', category_id: 'x' }),
      F({ key: 'serviced', type: 'date', category_id: 'x' }),
      F({ key: 'manual', type: 'url', category_id: 'x' }),
      F({ key: 'source', type: 'select', category_id: 'x', options: ['Mains', 'Battery'] }),
      F({ key: 'note', type: 'text', category_id: 'x' }),
    ];
    const ok = cleanCustom(
      tpl,
      { power_w: ' 1,500 ', bought_used: true, serviced: '2026-09-01', manual: 'https://x.lk/m.pdf', source: 'Mains', note: '  ' },
      { imei: '3569', power_w: 10 },
    );
    expect(ok.errors).toEqual({});
    expect(ok.value).toEqual({ imei: '3569', power_w: 1500, bought_used: true, serviced: '2026-09-01', manual: 'https://x.lk/m.pdf', source: 'Mains' });

    const bad = cleanCustom(tpl, { power_w: 'lots', serviced: '1/9/2026', manual: 'x.lk', source: 'Petrol' });
    expect(bad.errors).toEqual({ power_w: 'number', serviced: 'date', manual: 'url', source: 'option' });
  });

  it('display values', () => {
    expect(displayValue({ type: 'boolean' }, true, 'Yes')).toBe('Yes');
    expect(displayValue({ type: 'boolean' }, false, 'Yes')).toBe('');
    expect(displayValue({ type: 'number' }, 1500, 'Yes')).toBe('1,500');
    expect(displayValue({ type: 'text' }, undefined, 'Yes')).toBe('');
  });
});

describe('documents', () => {
  const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  it('recognises PDFs and images by their first bytes, not their name', () => {
    expect(sniffDocument(bytes('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf');
    expect(sniffDocument(bytes('\r\n%PDF-1.4'))).toBe('application/pdf');
    expect(sniffDocument(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffDocument(bytes('<html>not a pdf</html>'))).toBeNull();
    expect(sniffDocument(bytes('PK\u0003\u0004 a .docx renamed to .pdf'))).toBeNull();
  });
  it('sizes', () => {
    expect(formatBytes(2_400_000)).toBe('2.3 MB');
    expect(formatBytes(180 * 1024)).toBe('180 KB');
    expect(formatBytes(1)).toBe('1 KB');
    expect(formatBytes(null)).toBe('');
  });
});
