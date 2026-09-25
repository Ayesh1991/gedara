import { describe, expect, it } from 'vitest';
import { attentionTarget, groupBySeverity, hiddenUntil, knownItems, type AttentionItem } from '../attention';
import { suggestPayments, type MatchRule, type MatchTx } from '../recurring/match';
import { createShortcutReader, newTargetFor } from '../shortcuts';
import {
  InsightsSearchSchema,
  crumbs,
  drillInto,
  monthsOf,
  periodDates,
  periodOf,
  spendFilter,
  spendGroupBy,
  spendLevel,
} from './drill';
import { personalInflation } from './inflation';

const CAT = '11111111-1111-1111-1111-111111111111';
const SUB = '22222222-2222-2222-2222-222222222222';
const PRD = '33333333-3333-3333-3333-333333333333';

describe('drill-down URL contract', () => {
  it('parses shared URLs where the router turned values into numbers', () => {
    const s = InsightsSearchSchema.parse({ from: '2026-05', to: '2026-09', cat: CAT, weekday: 3, hour: 18 });
    expect(s).toMatchObject({ from: '2026-05', to: '2026-09', cat: CAT, weekday: '3', hour: '18' });
    expect(() => InsightsSearchSchema.parse({ cat: 'x' })).toThrow();
    expect(() => InsightsSearchSchema.parse({ from: '2026-9' })).toThrow();
  });

  it('defaults to the last 12 months; one month when only `from` is given', () => {
    expect(periodOf({}, '2026-09-25')).toEqual({ from: '2025-10', to: '2026-09' });
    expect(periodOf({ from: '2026-07' }, '2026-09-25')).toEqual({ from: '2026-07', to: '2026-07' });
    expect(periodOf({ from: '2026-09', to: '2026-05' }, '2026-09-25')).toEqual({ from: '2026-05', to: '2026-09' });
    expect(periodDates({ from: '2026-02', to: '2026-02' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthsOf({ from: '2025-11', to: '2026-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('walks Domain → Category → Sub-category / Product → records', () => {
    expect(spendLevel({}, true)).toBe('domain');
    expect(spendLevel({ cat: CAT }, true)).toBe('category');
    expect(spendLevel({ cat: CAT }, false)).toBe('item'); // no subs: straight to products
    expect(spendLevel({ cat: CAT, sub: SUB }, true)).toBe('item');
    expect(spendLevel({ cat: CAT, sub: SUB, product: PRD }, true)).toBe('records');
    expect(spendLevel({ name: 'keeri samba 5kg' }, true)).toBe('records');
    expect(spendLevel({ weekday: '6', hour: '10' }, true)).toBe('records');

    expect(spendGroupBy('domain', undefined)).toBe('top');
    expect(spendGroupBy('domain', 'time')).toBe('weekday_hour');
    expect(spendGroupBy('category', 'merchant')).toBe('category');
    expect(drillInto('domain', undefined, CAT)).toEqual({ cat: CAT });
    expect(drillInto('category', undefined, SUB)).toEqual({ sub: SUB });
    expect(drillInto('item', undefined, PRD)).toEqual({ product: PRD });
    expect(drillInto('item', undefined, 'n:keeri samba 5kg')).toEqual({ name: 'keeri samba 5kg' });
    expect(drillInto('domain', 'merchant', 'none')).toEqual({ merchant: 'none', by: undefined });
    expect(drillInto('domain', 'time', '6:10')).toEqual({ weekday: '6', hour: '10', by: undefined });
  });

  it('turns the URL into the database filter', () => {
    expect(spendFilter({ cat: CAT, recurring: 'yes', by: 'merchant' }, { from: '2026-09', to: '2026-09' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      cat: CAT,
      recurring: 'true',
    });
  });

  it('builds a breadcrumb where each step drops what comes after it', () => {
    const c = crumbs({ from: '2026-01', merchant: 'none', cat: CAT, sub: SUB, product: PRD });
    expect(c.map((x) => x.key)).toEqual(['area', 'merchant', 'cat', 'sub', 'product']);
    expect(c[2]!.search).toEqual({ from: '2026-01', to: undefined, view: undefined, merchant: 'none', cat: CAT });
    expect(c[0]!.search).not.toHaveProperty('cat');
  });
});

describe('personal inflation index', () => {
  const row = (product_id: string, month: string, qty: number, spent: number) => ({
    product_id,
    product_name: product_id,
    month,
    qty,
    spent,
  });

  it('chain-links spend-weighted price relatives from 100', () => {
    const r = personalInflation([
      row('rice', '2026-05', 5, 1000), // Rs 200/kg
      row('rice', '2026-06', 5, 1100), // Rs 220 (+10 %)
      row('milk', '2026-05', 10, 1000), // Rs 100
      row('milk', '2026-06', 10, 1000), // Rs 100 (0 %)
    ]);
    // weights: rice 2100, milk 2000 → (2100 × 1.1 + 2000 × 1) / 4100 = 1.05122
    expect(r.points).toEqual([
      { month: '2026-05', index: 100, basket: 0 },
      { month: '2026-06', index: 105.12, basket: 2 },
    ]);
    expect(r.change).toBeCloseTo(0.0512, 4);
    expect(r.movers[0]).toMatchObject({ product_id: 'rice', first: 200, last: 220 });
  });

  it('carries a month with nothing in common instead of inventing a number', () => {
    const r = personalInflation([row('rice', '2026-05', 1, 200), row('milk', '2026-06', 1, 100)]);
    expect(r.points.map((p) => [p.index, p.basket])).toEqual([
      [100, 0],
      [100, 0],
    ]);
    expect(r.change).toBeNull();
    expect(personalInflation([]).points).toEqual([]);
  });

  it('adds up several shops in a month before comparing', () => {
    const r = personalInflation([
      row('sugar', '2026-05', 1, 300),
      row('sugar', '2026-05', 1, 340),
      row('sugar', '2026-06', 2, 640),
    ]);
    expect(r.points[1]!.index).toBe(100);
  });
});

describe('attention', () => {
  const item = (over: Partial<AttentionItem>): AttentionItem => ({
    item_key: 'k',
    kind: 'expired',
    severity: 'red',
    entity_type: 'product',
    entity_id: PRD,
    title: 'Milk',
    due_on: null,
    days_left: null,
    amount: null,
    qty: null,
    unit: null,
    extra: {},
    ...over,
  });

  it('leads each kind to the record it is about', () => {
    expect(attentionTarget(item({}))).toEqual({ to: '/pantry/$productId', params: { productId: PRD } });
    expect(attentionTarget(item({ kind: 'bill_due', entity_id: CAT }))).toEqual({ to: '/money/recurring', search: { pay: CAT } });
    expect(attentionTarget(item({ kind: 'service_due', entity_id: SUB }))).toEqual({ to: '/things/$assetId', params: { assetId: SUB } });
    expect(attentionTarget(item({ kind: 'sms_review', entity_id: null }))).toEqual({ to: '/money/inbox' });
    expect(attentionTarget(item({ kind: 'budget_over', entity_id: CAT, extra: { month: '2026-09' } }))).toEqual({
      to: '/insights/$area',
      params: { area: 'spend' },
      search: { cat: CAT, from: '2026-09', to: '2026-09' },
    });
  });

  it('groups by colour, most urgent first, and ignores kinds it does not know', () => {
    const g = groupBySeverity([item({ severity: 'violet' }), item({ severity: 'red' }), item({ severity: 'violet', title: 'B' })]);
    expect(g.map(([s, xs]) => [s, xs.length])).toEqual([
      ['red', 1],
      ['violet', 2],
    ]);
    expect(knownItems([item({}), item({ kind: 'future_kind' as never })])).toHaveLength(1);
  });

  it('hides until tomorrow, for a week, or until it changes', () => {
    expect(hiddenUntil('tomorrow', '2026-09-30')).toBe('2026-10-01');
    expect(hiddenUntil('week', '2026-09-25')).toBe('2026-10-02');
    expect(hiddenUntil('change', '2026-09-25')).toBeNull();
  });
});

describe('recurring: bills already in Money', () => {
  const rule: MatchRule = {
    type: 'expense',
    category_id: 'elec',
    top_category_id: 'energy',
    payee_text: 'CEB',
    expected_amount: 5000,
    last_amount: null,
    next_due: '2026-09-20',
  };
  const tx = (id: string, over: Partial<MatchTx>): MatchTx => ({
    id,
    type: 'expense',
    occurred_on: '2026-09-21',
    total: 5100,
    payee_text: null,
    recurring_id: null,
    category_ids: ['elec'],
    ...over,
  });

  it('suggests same-category or same-payee payments near the due date within ±20 %', () => {
    const out = suggestPayments(rule, [
      tx('near', {}),
      tx('payee', { category_ids: [], payee_text: 'CEB Kandy', occurred_on: '2026-09-19' }),
      tx('both', { payee_text: 'ceb', occurred_on: '2026-09-25' }),
      tx('far', { occurred_on: '2026-10-05' }),
      tx('dear', { total: 9000 }),
      tx('linked', { recurring_id: 'x' }),
      tx('other', { category_ids: ['water'] }),
      tx('income', { type: 'income' }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['both', 'near', 'payee']);
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; typing: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    typing: false,
    ...over,
  });

  it('opens the palette with ⌘K / Ctrl+K even while typing, and with /', () => {
    const read = createShortcutReader();
    expect(read(key('k', { metaKey: true, typing: true }))).toEqual({ type: 'palette' });
    expect(read(key('K', { ctrlKey: true }))).toEqual({ type: 'palette' });
    expect(read(key('/'))).toEqual({ type: 'palette' });
    expect(read(key('/', { typing: true }))).toBeNull();
  });

  it('G then a letter goes to a section within 1.5 s', () => {
    let now = 0;
    const read = createShortcutReader(() => now);
    expect(read(key('g'))).toBeNull();
    now = 500;
    expect(read(key('p'))).toEqual({ type: 'go', to: '/pantry' });
    expect(read(key('g'))).toBeNull();
    now = 3000;
    expect(read(key('p'))).toBeNull();
    expect(read(key('n'))).toEqual({ type: 'new' });
    expect(read(key('s'))).toEqual({ type: 'scan' });
    expect(read(key('?'))).toEqual({ type: 'help' });
  });

  it('N means a new thing on the page you are on', () => {
    expect(newTargetFor('/money/accounts')).toEqual({ to: '/money', search: { add: 'expense' } });
    expect(newTargetFor('/pantry')).toEqual({ to: '/pantry', search: { new: '1' } });
    expect(newTargetFor('/')).toBeNull();
  });
});
