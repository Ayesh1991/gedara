// Matching suggestions, settings and the accuracy report (Phase 9b). Reads go straight to the tables /
// views (RLS); writes are RPCs; runs go through the match-agent Edge Function, which works with the
// service role after the database said who may ask (rpc_match_request).
import { queryOptions } from '@tanstack/react-query';
import type { Json } from '../db.types';
import { moneyKey } from '../money/queries';
import { supabase } from '../supabase';

export type MatchTask = 'line_product' | 'line_category' | 'line_thing' | 'sms_category' | 'sms_link' | 'sms_rebook' | 'sms_recategorise' | 'sms_topup';

export interface Suggestion {
  id: string;
  task: MatchTask;
  target_key: string;
  line_id: string | null;
  sms_id: string | null;
  proposal: {
    product_id?: string | null;
    destiny?: 'stock' | 'expense';
    category_id?: string | null;
    transaction_id?: string;
    name?: string;
    maker?: string | null;
    model?: string | null;
    /** sms_category: the payee whose confirmation decided it (pattern evidence); how many past choices agree (history) */
    evidence?: string;
    past?: number;
    /** sms_rebook (rpc_sms_rebook's parameter) / sms_recategorise (Phase 9b.1) */
    debit_sms?: string;
    delete_tx?: string[];
    transfer_id?: string | null;
    to_account_id?: string | null;
    payment_sms?: string | null;
    total?: number;
    fee?: number;
    fee_category_id?: string | null;
    from_account_id?: string;
    card_account_id?: string;
    was_category_id?: string | null;
    line_id?: string;
    payee?: string;
    receipt_sms?: string;
    /** sms_topup (9b.2): the stretch of the bank's balance chain the money went missing in */
    since?: string;
    occurred_on?: string;
  };
  confidence: number;
  pattern: string;
  models: string[];
  updated_at: string;
  line: {
    raw_name: string;
    amount: number;
    category_id: string | null;
    transaction: { id: string; payee_text: string | null; occurred_on: string } | null;
  } | null;
}

export const suggestionsQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'match-suggestions'),
    queryFn: async (): Promise<Suggestion[]> => {
      const { data, error } = await supabase
        .from('match_suggestion')
        .select(`id, task, target_key, line_id, sms_id, proposal, confidence, pattern, models, updated_at,
          line:transaction_line!match_suggestion_household_id_line_id_fkey(raw_name, amount, category_id,
            transaction:money_transaction!transaction_line_household_id_transaction_id_fkey(id, payee_text, occurred_on))`)
        .eq('household_id', householdId)
        .eq('status', 'pending')
        .order('confidence', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as unknown as Suggestion[];
    },
    staleTime: 30 * 1000,
  });

export interface MatchSetting {
  ai_enabled: boolean;
  steps: Array<{ provider: 'groq' | 'gemini' | 'openai'; model: string }>;
  monthly_cap_usd: number;
  daily_requests: number;
}

export const DEFAULT_SETTING: MatchSetting = {
  ai_enabled: false,
  steps: [
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openai', model: 'gpt-6-luna' },
    { provider: 'gemini', model: 'gemini-3.8-flash' },
  ],
  monthly_cap_usd: 0.9,
  daily_requests: 150,
};

export const matchSettingQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'match-setting'),
    queryFn: async (): Promise<MatchSetting> => {
      const { data, error } = await supabase
        .from('match_setting')
        .select('ai_enabled, steps, monthly_cap_usd, daily_requests')
        .eq('household_id', householdId)
        .maybeSingle();
      if (error) throw error;
      return data
        ? { ...(data as unknown as MatchSetting), monthly_cap_usd: Number(data.monthly_cap_usd) }
        : DEFAULT_SETTING;
    },
  });

export interface Accuracy {
  task: string;
  n: number;
  rule_answered: number;
  rule_correct: number;
  ai_answered: number;
  ai_correct: number;
  sure_n: number;
  sure_correct: number;
  tested_at: string;
  /** 9b.1: right main category; confirmed by a payee's evidence; past choices evidence contradicts; no shop named */
  ai_main_correct: number;
  evidence_n: number;
  contradicted_n: number;
  no_shop_n: number;
}
export interface PatternRow {
  task: string;
  pattern: string;
  n: number;
  correct: number;
}
export interface DecisionRow {
  task: string;
  pattern: string;
  n: number;
  accepted: number;
  changed: number;
  rejected: number;
  pending: number;
}
export interface CostRow {
  provider: string;
  model: string;
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
export interface RunRow {
  id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, number | boolean>;
}

export const matchReportQuery = (householdId: string, month: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'match-report', month),
    queryFn: async () => {
      const [acc, pat, dec, cost, runs] = await Promise.all([
        supabase.from('v_match_accuracy').select('task, n, rule_answered, rule_correct, ai_answered, ai_correct, sure_n, sure_correct, tested_at, ai_main_correct, evidence_n, contradicted_n, no_shop_n').eq('household_id', householdId),
        supabase.from('v_match_accuracy_pattern').select('task, pattern, n, correct').eq('household_id', householdId),
        supabase.from('v_match_decisions').select('task, pattern, n, accepted, changed, rejected, pending').eq('household_id', householdId),
        supabase.from('v_ai_cost_month').select('provider, model, requests, failed, input_tokens, output_tokens, cost_usd').eq('household_id', householdId).eq('month', month),
        supabase.from('match_run').select('id, trigger, started_at, finished_at, stats').eq('household_id', householdId).order('started_at', { ascending: false }).limit(8),
      ]);
      for (const r of [acc, pat, dec, cost, runs]) if (r.error) throw r.error;
      return {
        accuracy: (acc.data ?? []) as Accuracy[],
        patterns: (pat.data ?? []) as PatternRow[],
        decisions: (dec.data ?? []) as DecisionRow[],
        cost: ((cost.data ?? []) as CostRow[]).map((c) => ({ ...c, cost_usd: Number(c.cost_usd) })),
        runs: (runs.data ?? []) as unknown as RunRow[],
      };
    },
    staleTime: 30 * 1000,
  });

/** The function's own view: its version and which keys are set (never the keys). */
export const agentStatusQuery = () =>
  queryOptions({
    queryKey: ['match-agent-status'],
    queryFn: async (): Promise<{ fn_version: string; keys: Record<'groq' | 'gemini' | 'openai', boolean> }> => {
      const { data, error } = await supabase.functions.invoke('match-agent', { method: 'GET' });
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

export class TooOften extends Error {}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('match-agent', { body });
  if (error) {
    const status = (error as { context?: Response }).context?.status;
    if (status === 429) throw new TooOften();
    throw error;
  }
  return data as T;
}

export const checkNow = (householdId: string) =>
  invoke<{ ok: true; stats: Record<string, number> }>({ household_id: householdId, mode: 'run' });
export const evalBatch = (householdId: string) =>
  invoke<{ ok: true; remaining: number; total: number; stats: Record<string, number> }>({ household_id: householdId, mode: 'eval' });
export const checkKeys = (householdId: string) =>
  invoke<{ ok: true; results: Array<{ provider: string; model: string; ok: boolean; error: string | null }> }>({ household_id: householdId, mode: 'check' });

export async function saveMatchSetting(householdId: string, p: Partial<MatchSetting>) {
  const { error } = await supabase.rpc('rpc_match_settings_save', { p_household: householdId, p: p as unknown as Json });
  if (error) throw error;
}

export async function decide(ids: string[], status: 'accepted' | 'changed' | 'rejected', correction?: Record<string, unknown>) {
  const { error } = await supabase.rpc('rpc_match_decide', {
    p_ids: ids,
    p_status: status,
    p_correction: (correction ?? null) as unknown as Json,
  });
  if (error) throw error;
}

export async function linkLineProduct(lineId: string, productId: string | null, destiny: 'stock' | 'expense') {
  const { error } = await supabase.rpc('rpc_line_link_product', { p_line: lineId, p_product: productId as string, p_destiny: destiny });
  if (error) throw error;
}

/** "Check past bookings" (9b.1): the alerts a fix is about (parsed fields only). */
export interface PastAlert {
  id: string;
  sender: string;
  kind: string;
  amount: number | null;
  merchant_text: string | null;
  occurred_on: string;
  account_id: string | null;
}

export const pastAlertsQuery = (householdId: string, ids: string[]) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'match-past-alerts', ids.slice().sort().join(',')),
    queryFn: async (): Promise<Map<string, PastAlert>> => {
      if (!ids.length) return new Map();
      const { data, error } = await supabase
        .from('sms_message')
        .select('id, sender, kind, amount, merchant_text, occurred_on, account_id')
        .eq('household_id', householdId)
        .in('id', ids);
      if (error) throw error;
      return new Map((data as PastAlert[]).map((a) => [a.id, a]));
    },
    staleTime: 30 * 1000,
  });

/** One database step: the wrong expense goes, the debit joins (or makes) the transfer, the fee is its own expense. */
export async function rebook(p: NonNullable<Suggestion['proposal']>) {
  const { error } = await supabase.rpc('rpc_sms_rebook', {
    p: {
      debit_sms: p.debit_sms, delete_tx: p.delete_tx ?? [], transfer_id: p.transfer_id ?? null, to_account_id: p.to_account_id ?? null,
      payment_sms: p.payment_sms ?? null, total: p.total, fee: p.fee ?? 0, fee_category_id: p.fee_category_id ?? null,
    } as unknown as Json,
  });
  if (error) throw error;
}

export async function setLineCategory(lineId: string, categoryId: string) {
  const { error } = await supabase.rpc('rpc_line_category', { p_line: lineId, p_category: categoryId });
  if (error) throw error;
}
