// Recurring bills (Phase 6): rules are plain table writes (RLS); paying / linking goes through the
// RPCs of migration 42, so the payment and its link are one step and deleting the payment makes the
// bill due again. Keys live under money so a new / deleted transaction refreshes them.
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { lineFingerprint, manualFingerprint } from '../money/fingerprint';
import { moneyKey } from '../money/queries';
import { addMonths } from '../time';
import type { EveryUnit, MatchTx, UsageUnit } from './match';

export interface RecurringRule {
  id: string;
  household_id: string;
  name: string;
  type: 'expense' | 'income';
  account_id: string | null;
  category_id: string | null;
  top_category_id: string | null;
  category_name: string | null;
  account_name: string | null;
  asset_id: string | null;
  asset_name: string | null;
  payee_text: string | null;
  expected_amount: number | null;
  every_n: number;
  every_unit: EveryUnit;
  first_due: string;
  notify_days_before: number;
  usage_unit: UsageUnit | null;
  active: boolean;
  notes: string | null;
  last_period: string | null;
  last_paid_on: string | null;
  last_amount: number | null;
  last_transaction_id: string | null;
  payments: number;
  last_skipped: string | null;
  next_due: string;
  days_left: number;
}

export const rulesQuery = (householdId: string) =>
  queryOptions({
    queryKey: [...moneyKey(householdId, 'recurring')],
    queryFn: async (): Promise<RecurringRule[]> => {
      const { data, error } = await supabase
        .from('v_recurring_due')
        .select('*')
        .eq('household_id', householdId)
        .order('next_due');
      if (error) throw error;
      return data as unknown as RecurringRule[];
    },
    staleTime: 30 * 1000,
  });

export interface RuleInput {
  name: string;
  type: 'expense' | 'income';
  account_id: string | null;
  category_id: string | null;
  payee_text: string | null;
  expected_amount: number | null;
  every_n: number;
  every_unit: EveryUnit;
  first_due: string;
  notify_days_before: number;
  usage_unit: UsageUnit | null;
  asset_id: string | null;
  notes: string | null;
  active?: boolean;
}

export async function createRule(householdId: string, input: RuleInput): Promise<string> {
  const { data, error } = await supabase
    .from('recurring_rule')
    .insert({ household_id: householdId, ...input })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateRule(id: string, patch: Partial<RuleInput>) {
  const { error } = await supabase.from('recurring_rule').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteRule(id: string) {
  const { error } = await supabase.from('recurring_rule').delete().eq('id', id);
  if (error) throw error;
}

export interface PayInput {
  rule: RecurringRule;
  period?: string;
  account_id: string;
  category_id: string | null;
  occurred_on: string;
  total: number;
  payee_text: string | null;
  notes: string | null;
  units: number | null;
}

/** Saves the expense / income with one line in the rule's category and links it. */
export async function payRecurring(p: PayInput): Promise<{ id: string; period: string }> {
  const payee = p.payee_text?.trim() || p.rule.payee_text || p.rule.name;
  const fp = manualFingerprint({ type: p.rule.type, date: p.occurred_on, accountId: p.account_id, payee, total: p.total });
  const name = p.rule.name.slice(0, 200);
  const { data, error } = await supabase.rpc('rpc_recurring_pay', {
    p: {
      rule_id: p.rule.id,
      period: p.period ?? null,
      units: p.units,
      transaction: {
        type: p.rule.type,
        account_id: p.account_id,
        payee_text: payee,
        occurred_on: p.occurred_on,
        total: p.total,
        notes: p.notes,
        fingerprint: fp,
        lines: [{ line_no: 0, raw_name: name, category_id: p.category_id, amount: p.total, fingerprint: lineFingerprint(fp, 0, name, p.total) }],
      },
    },
  });
  if (error) throw error;
  return data as unknown as { id: string; period: string };
}

export async function linkRecurring(ruleId: string, transactionId: string, units: number | null, period?: string): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_recurring_link', {
    p_rule: ruleId,
    p_transaction: transactionId,
    p_period: period ?? undefined,
    p_units: units ?? undefined,
  });
  if (error) throw error;
  return data as unknown as string;
}

export async function unlinkRecurring(transactionId: string) {
  const { error } = await supabase.rpc('rpc_recurring_unlink', { p_transaction: transactionId });
  if (error) throw error;
}

export async function skipPeriod(householdId: string, ruleId: string, period: string): Promise<string> {
  const { data, error } = await supabase
    .from('recurring_skip')
    .insert({ household_id: householdId, rule_id: ruleId, period })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function unskip(id: string) {
  const { error } = await supabase.from('recurring_skip').delete().eq('id', id);
  if (error) throw error;
}

/** Recent unlinked transactions for "Link a bill already in Money" (last ~3 months). */
export const linkCandidatesQuery = (householdId: string, today: string) =>
  queryOptions({
    queryKey: [...moneyKey(householdId, 'recurring-candidates', today)],
    queryFn: async (): Promise<MatchTx[]> => {
      const { data, error } = await supabase
        .from('money_transaction')
        .select('id, type, occurred_on, total, payee_text, recurring_id, transaction_line (category_id)')
        .eq('household_id', householdId)
        .in('type', ['expense', 'income'])
        .is('recurring_id', null)
        .gte('occurred_on', `${addMonths(today.slice(0, 7), -3)}-01`)
        .order('occurred_on', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data as unknown as (Omit<MatchTx, 'category_ids'> & { transaction_line: { category_id: string | null }[] })[]).map(
        ({ transaction_line, ...t }) => ({
          ...t,
          category_ids: transaction_line.map((l) => l.category_id).filter((c): c is string => c !== null),
        }),
      );
    },
    staleTime: 30 * 1000,
  });

/** Postgres / RPC error → i18n key suffix under recurring.errors. */
export function recurringErrorKey(e: unknown): 'paid' | 'duplicate' | 'invalid' | 'reference' | 'denied' | 'nameTaken' | 'generic' {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDRPP') return 'paid';
  if (code === 'GDDUP') return 'duplicate';
  if (code === '23514') return 'invalid';
  if (code === '23503') return 'reference';
  if (code === '42501') return 'denied';
  if (code === '23505') return 'nameTaken';
  return 'generic';
}
