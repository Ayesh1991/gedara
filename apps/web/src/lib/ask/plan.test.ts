import { describe, expect, it } from 'vitest';
import { ASK_TOOLS, AskPlan, PLAN_SCHEMA, toPlan } from '@ask/plan';

// Phase 10 · the model's answer is only a plan: a tool from the fixed list with typed arguments. Anything
// else — another tool, an extra field, a bad date, markup in `about`, too many calls — refuses the plan.

const TODAY = '2026-11-03';
const call = (p: Record<string, unknown>) => ({
  tool: 'ask_spend', about: null, from: null, to: null, group: null, view: null, within_days: null, month: null, limit: null, ...p,
});
const plan = (calls: unknown[], refusal: string | null = null) => JSON.stringify({ calls, refusal });

describe('PLAN_SCHEMA', () => {
  it('is strict: every property required, nothing extra allowed', () => {
    const walk = (s: Record<string, unknown>) => {
      if (s.type === 'object') {
        expect(s.additionalProperties).toBe(false);
        expect([...(s.required as string[])].sort()).toEqual(Object.keys(s.properties as object).sort());
        for (const v of Object.values(s.properties as Record<string, Record<string, unknown>>)) walk(v);
      }
      if (s.items) walk(s.items as Record<string, unknown>);
    };
    walk(PLAN_SCHEMA as unknown as Record<string, unknown>);
  });

  it('offers exactly the nine ask_* tools', () => {
    expect(PLAN_SCHEMA.properties.calls.items.properties.tool.enum).toEqual([...ASK_TOOLS]);
    expect(ASK_TOOLS).toHaveLength(9);
  });
});

describe('toPlan', () => {
  it('turns a spend question into the SQL arguments', () => {
    expect(toPlan(plan([call({ about: 'fish', from: '2026-06-01', to: TODAY })]), TODAY)).toEqual({
      calls: [{ tool: 'ask_spend', args: { p_about: 'fish', p_from: '2026-06-01', p_to: TODAY, p_group: null } }],
      refusal: null,
    });
  });

  it('fills defaults and drops fields a tool does not use', () => {
    const p = toPlan(
      plan([
        call({ tool: 'ask_transactions', about: 'fuel', from: '2026-08-01', to: TODAY }),
        call({ tool: 'ask_pantry', view: 'runout', about: 'ignored', from: '2026-01-01' }),
        call({ tool: 'ask_budget', month: '2026-10' }),
      ]),
      TODAY,
    );
    expect(p?.calls).toEqual([
      { tool: 'ask_transactions', args: { p_about: 'fuel', p_from: '2026-08-01', p_to: TODAY, p_limit: 5 } },
      { tool: 'ask_pantry', args: { p_view: 'runout', p_within_days: 7 } },
      { tool: 'ask_budget', args: { p_month: '2026-10-01' } },
    ]);
  });

  it('keeps refusals, and an empty plan is "other"', () => {
    expect(toPlan(plan([], 'write'), TODAY)).toEqual({ calls: [], refusal: 'write' });
    expect(toPlan(plan([call({ about: 'fish' })], 'house'), TODAY)).toEqual({ calls: [], refusal: 'house' });
    expect(toPlan(plan([]), TODAY)).toEqual({ calls: [], refusal: 'other' });
  });

  it.each([
    ['not JSON', 'Sure! Here is the plan'],
    ['another tool', plan([call({ tool: 'rpc_delete_transaction' })])],
    ['free SQL', plan([call({ tool: 'sql', about: 'select * from sms_message' })])],
    ['an extra field', JSON.stringify({ calls: [{ ...call({}), sql: 'select 1' }], refusal: null })],
    ['an extra top-level field', JSON.stringify({ calls: [], refusal: null, answer: 'Rs 12,340' })],
    ['a missing field', JSON.stringify({ calls: [{ tool: 'ask_spend', about: 'fish' }], refusal: null })],
    ['four calls', plan([call({}), call({}), call({}), call({})])],
    ['an unknown refusal', plan([], 'maybe')],
    ['a date before 2020', plan([call({ from: '2019-12-31', to: '2020-02-01' })])],
    ['more than 3 years', plan([call({ from: '2020-01-01', to: '2026-01-01' })])],
    ['from after to', plan([call({ from: '2026-07-01', to: '2026-06-01' })])],
    ['too far ahead', plan([call({ from: '2026-11-01', to: '2028-01-01' })])],
    ['not a date', plan([call({ from: 'June', to: TODAY })])],
    ['markup in about', plan([call({ about: '<img src=x onerror=alert(1)>' })])],
    ['a URL in about', plan([call({ about: 'https://evil.example' })])],
    ['quotes in about', plan([call({ about: "fish'; drop table" })])],
    ['a 61-character about', plan([call({ about: 'x'.repeat(61) })])],
    ['find without words', plan([call({ tool: 'ask_find' })])],
    ['pantry without a view', plan([call({ tool: 'ask_pantry' })])],
    ['pantry beyond 60 days', plan([call({ tool: 'ask_pantry', view: 'expiring', within_days: 90 })])],
    ['11 rows', plan([call({ tool: 'ask_transactions', limit: 11 })])],
    ['a budget month in words', plan([call({ tool: 'ask_budget', month: 'October' })])],
    ['warranties beyond 400 days', plan([call({ tool: 'ask_warranty', within_days: 401 })])],
  ])('refuses %s', (_name, text) => {
    expect(toPlan(text, TODAY)).toBeNull();
  });
});

describe('AskPlan (what the browser accepts)', () => {
  it('refuses a call shaped for another tool', () => {
    expect(AskPlan.safeParse({ calls: [{ tool: 'ask_find', args: { p_about: 'drill', p_from: '2026-01-01' } }], refusal: null }).success).toBe(false);
    expect(AskPlan.safeParse({ calls: [{ tool: 'ask_find', args: { p_about: 'drill' } }], refusal: null }).success).toBe(true);
  });
});
