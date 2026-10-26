import { describe, expect, it } from 'vitest';
import {
  dueInMonth,
  endings,
  firstFromCurrent,
  instalmentDate,
  loanInstalment,
  paidCount,
  planFromAlert,
  planStatus,
  type PlanFacts,
} from './instalments';

// Phase 9b.2: the plans from Didula's statements (October 2026) — the numbers on the Instalments page.
const card = (monthly: number, total: number, first_on: string): PlanFacts => ({ kind: 'card', monthly, total_count: total, first_on });

describe('dates', () => {
  it('the first instalment from "n of N fell on" a statement date', () => {
    expect(firstFromCurrent('2026-10-09', 7)).toBe('2026-04-09'); // Toyota Lanka 7/12 on 9 Oct
    expect(firstFromCurrent('2026-06-30', 9)).toBe('2025-10-30'); // Luxury X 9/24 on 30 Jun
    expect(firstFromCurrent('2026-06-10', 7)).toBe('2025-12-10'); // H D S 7/36 on 10 Jun
  });

  it('later instalments keep the day, or the month\'s last day', () => {
    expect(instalmentDate('2026-04-09', 12)).toBe('2027-03-09');
    expect(instalmentDate('2025-10-30', 24)).toBe('2027-09-30');
    expect(instalmentDate('2025-10-30', 5)).toBe('2026-02-28');
    expect(instalmentDate('2025-12-10', 36)).toBe('2028-11-10');
  });

  it('counts the instalments fallen due by a day', () => {
    const toyota = card(6470.72, 12, '2026-04-09');
    expect(paidCount(toyota, '2026-10-08')).toBe(6);
    expect(paidCount(toyota, '2026-10-09')).toBe(7);
    expect(paidCount(toyota, '2026-03-01')).toBe(0);
    expect(paidCount(toyota, '2030-01-01')).toBe(12);
  });
});

describe('the October 2026 snapshot', () => {
  const today = '2026-10-26';

  it('a card plan: now, left, last date', () => {
    expect(planStatus(card(6470.72, 12, '2026-04-09'), today)).toMatchObject({
      paid: 7, current: 7, left: 5, nextOn: '2026-11-09', lastOn: '2027-03-09', leftToPay: 32353.6, done: false, loan: null,
    });
    // Luxury X: 12 of 24 paid by 26 Oct (the 13th falls on 30 Oct)
    expect(planStatus(card(11759.17, 24, '2025-10-30'), today)).toMatchObject({ paid: 12, left: 12, nextOn: '2026-10-30', lastOn: '2027-09-30' });
  });

  it('the BOC loan: Rs 2,000,000 at 12 % for 60 months is Rs 44,488.90; the first is Rs 20,000 interest', () => {
    expect(loanInstalment(2000000, 12, 60)).toBe(44488.9);
    const loan: PlanFacts = { kind: 'loan', monthly: 44488.9, total_count: 60, first_on: '2026-10-24', principal: 2000000, annual_rate: 12 };
    const before = planStatus(loan, '2026-10-23');
    expect(before.loan).toMatchObject({ owed: 2000000, nextInterest: 20000, nextPrincipal: 24488.9 });
    const now = planStatus(loan, today);
    expect(now).toMatchObject({ paid: 1, left: 59, lastOn: '2031-09-24', nextOn: '2026-11-24' });
    expect(now.loan).toMatchObject({ owed: 1975511.1, nextInterest: 19755.11, nextPrincipal: 24733.79 });
    expect(now.loan!.interestLeft).toBeCloseTo(649334.0, 0);
    expect(planStatus(loan, '2031-09-24').loan).toMatchObject({ owed: 0, nextInterest: 0 });
  });

  it('this month\'s total and when it drops', () => {
    const plans = [
      { ...card(6470.72, 12, '2026-04-09'), name: 'Toyota' },
      { ...card(8420.52, 12, '2026-05-30'), name: 'SLI' },
      { ...card(8625, 12, '2026-07-21'), name: 'PGIM' },
      { ...card(11759.17, 24, '2025-10-30'), name: 'Luxury X' },
      { ...card(5000, 36, '2025-12-10'), name: 'HDS' },
      { ...card(5916.39, 36, '2025-12-18'), name: 'ABANS' },
    ];
    expect(plans.filter((p) => dueInMonth(p, '2026-10')).reduce((s, p) => s + p.monthly, 0)).toBeCloseTo(46191.8, 2);
    const e = endings(plans, today);
    expect(e.map((x) => [x.month, x.drop])).toEqual([
      ['2027-03', 6470.72], ['2027-04', 8420.52], ['2027-06', 8625], ['2027-09', 11759.17], ['2028-11', 10916.39],
    ]);
  });
});

describe("People's plan alert", () => {
  it('reads months and the amount', () => {
    expect(planFromAlert("Dear Card Holder, 12-months instalment plan for LKR 123,456.00/= transaction at E2E PLAN successfully created. Hotline 1961."))
      .toEqual({ months: 12, total: 123456 });
    expect(planFromAlert('Payment received')).toBeNull();
  });
});
