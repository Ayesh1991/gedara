// Instalment plans (Phase 9b.2): read and written straight on the table (RLS: members read, owners and
// members write). The maths lives in ./instalments.ts.
import { queryOptions } from '@tanstack/react-query';
import type { Tables } from '../db.types';
import { supabase } from '../supabase';
import { moneyKey } from './queries';

export type Plan = Pick<
  Tables<'instalment_plan'>,
  'id' | 'account_id' | 'kind' | 'name' | 'monthly' | 'total_count' | 'first_on' | 'principal' | 'annual_rate' | 'source_sms_id' | 'notes' | 'archived'
> & { kind: 'card' | 'loan' };

export interface PlanInput {
  account_id: string;
  kind: 'card' | 'loan';
  name: string;
  monthly: number;
  total_count: number;
  first_on: string;
  principal: number | null;
  annual_rate: number | null;
  source_sms_id?: string | null;
  notes?: string | null;
}

export const plansQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'instalment-plans'),
    queryFn: async (): Promise<Plan[]> => {
      const { data, error } = await supabase
        .from('instalment_plan')
        .select('id, account_id, kind, name, monthly, total_count, first_on, principal, annual_rate, source_sms_id, notes, archived')
        .eq('household_id', householdId)
        .order('first_on');
      if (error) throw error;
      return data.map((p) => ({
        ...p,
        kind: p.kind as 'card' | 'loan',
        monthly: Number(p.monthly),
        principal: p.principal === null ? null : Number(p.principal),
        annual_rate: p.annual_rate === null ? null : Number(p.annual_rate),
      }));
    },
  });

/** People's "…-months instalment plan … created" alerts: offered as plans until one points to them. */
export const planAlertsQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'instalment-alerts'),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_message')
        .select('id, body, amount, merchant_text, occurred_on, account_id')
        .eq('household_id', householdId)
        .eq('parser', 'peoples.instalment')
        .order('occurred_on', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

export async function savePlan(householdId: string, input: PlanInput, id?: string) {
  if (id) {
    // (which alert a plan came from is set once, when it is added)
    const { error } = await supabase.from('instalment_plan').update({
      account_id: input.account_id, kind: input.kind, name: input.name, monthly: input.monthly, total_count: input.total_count,
      first_on: input.first_on, principal: input.principal, annual_rate: input.annual_rate, notes: input.notes ?? null,
    }).eq('id', id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('instalment_plan').insert({ household_id: householdId, ...input });
    if (error) throw error;
  }
}

export async function deletePlan(id: string) {
  const { error } = await supabase.from('instalment_plan').delete().eq('id', id);
  if (error) throw error;
}
