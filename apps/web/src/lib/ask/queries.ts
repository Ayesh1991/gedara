// Ask Gedara (Phase 10): the app's side. One call to the ask-gedara Edge Function turns the question into a
// plan (the AI never sees our data); the plan's ask_* functions then run here with the person's own login,
// so RLS decides what they may see (viewers too). Only the nine names in ASK_TOOLS can ever be called, and
// every call is checked again with Zod first. Nothing is kept: no question, plan or answer is stored.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { ASK_TOOLS, AskCall, AskPlan, type AskTool } from '@ask/plan';
import { supabase } from '@/lib/supabase';

export interface AskStatus {
  enabled: boolean;
  limit: number;
  used: number;
  cap_usd: number;
  month_cost_usd: number;
}

export const askKey = (householdId: string, ...rest: unknown[]) => ['ask', householdId, ...rest] as const;

export const askStatusQuery = (householdId: string) =>
  queryOptions({
    queryKey: askKey(householdId, 'status'),
    queryFn: async (): Promise<AskStatus> => {
      const { data, error } = await supabase.rpc('rpc_ask_status', { p_household: householdId });
      if (error) throw error;
      const d = data as unknown as AskStatus;
      return { ...d, cap_usd: Number(d.cap_usd), month_cost_usd: Number(d.month_cost_usd) };
    },
    staleTime: 60 * 1000,
  });

export type AskErrorCode =
  | 'off' | 'stopped' | 'limit' | 'cap' | 'not_member' | 'unsafe_question' | 'no_answer' | 'too_large' | 'network' | 'unknown';

export class AskError extends Error {
  constructor(
    readonly code: AskErrorCode,
    readonly reason?: string,
  ) {
    super(code);
    this.name = 'AskError';
  }
}

export interface AskResponse {
  plan: AskPlan;
  provider: 'groq' | 'openai';
  model: string;
  used: number;
  limit: number;
  today: string;
}

const invokeAsk = (householdId: string, question: string) =>
  supabase.functions.invoke('ask-gedara', { body: { household_id: householdId, request_id: crypto.randomUUID(), question } });

/** One question → one plan (one Edge Function call; no polling, no streaming). */
export async function askQuestion(householdId: string, question: string): Promise<AskResponse> {
  let { data, error } = await invokeAsk(householdId, question);
  // The platform's own 502/503/504 (no reply from the function, nothing counted): try once more.
  const first = (error as { context?: Response } | null)?.context;
  if (first && [502, 503, 504].includes(first.status) && !(first.headers.get('content-type') ?? '').includes('json')) {
    ({ data, error } = await invokeAsk(householdId, question));
  }
  if (error) {
    const res = (error as { context?: Response }).context;
    let body: { error?: string; reason?: string } = {};
    try {
      body = res ? await res.clone().json() : {};
    } catch {
      /* not JSON */
    }
    const known: AskErrorCode[] = ['off', 'stopped', 'limit', 'cap', 'not_member', 'unsafe_question', 'no_answer', 'too_large'];
    const code = known.includes(body.error as AskErrorCode) ? (body.error as AskErrorCode) : res ? 'unknown' : 'network';
    throw new AskError(code, body.reason);
  }
  const d = data as AskResponse;
  const plan = AskPlan.safeParse(d?.plan);
  if (!plan.success) throw new AskError('no_answer');
  return { ...d, plan: plan.data };
}

/** Runs one call of a plan with the person's own login. Only ask_* names from the fixed list. */
export async function runCall(householdId: string, call: AskCall): Promise<unknown> {
  const parsed = AskCall.parse(call);
  if (!(ASK_TOOLS as readonly string[]).includes(parsed.tool)) throw new Error('not an Ask tool');
  const { data, error } = await supabase.rpc(parsed.tool as AskTool, { p_household: householdId, ...parsed.args } as never);
  if (error) throw error;
  return data;
}

/**
 * Runs a call for an answer. An instalment question whose words match no plan ("pgim plan" when the plan is
 * called "Postgraduate inst. of Medicine") shows all running plans instead — a database call, no AI.
 */
export async function runForAnswer(householdId: string, call: AskCall): Promise<unknown> {
  const data = await runCall(householdId, call);
  if (call.tool === 'ask_instalments' && call.args.p_about && (data as { rows?: unknown[] } | null)?.rows?.length === 0) {
    return runCall(householdId, { tool: 'ask_instalments', args: { p_about: null } });
  }
  return data;
}

/** Is the emergency stop (secret ASK_OFF, scripts/ask-switch.mjs) on? The function's GET answers 503 'stopped'. */
export const askStoppedQuery = (householdId: string) =>
  queryOptions({
    queryKey: askKey(householdId, 'stopped'),
    queryFn: async (): Promise<boolean> => {
      const { error } = await supabase.functions.invoke('ask-gedara', { method: 'GET' });
      if (!error) return false;
      const res = (error as { context?: Response }).context;
      if (res?.status !== 503) return false;
      const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
      return body.error === 'stopped';
    },
    // checked again every time the page opens: right after the stop is ended, the card must go
    staleTime: 0,
    refetchOnMount: 'always',
  });

export async function saveAskSettings(householdId: string, p: { ask_enabled?: boolean; ask_daily_per_person?: number }) {
  const { error } = await supabase.rpc('rpc_ask_settings_save', { p_household: householdId, p });
  if (error) throw error;
}

export function invalidateAsk(qc: QueryClient, householdId: string) {
  return qc.invalidateQueries({ queryKey: ['ask', householdId] });
}

// ── Valuables (migration 98) ───────────────────────────────────────────────────
export interface Valuable {
  kind: 'asset' | 'location';
  id: string;
  name: string;
  path: string | null;
}

/** The owner's list of valuable things and places (others only see the things, without a place). */
export const valuablesQuery = (householdId: string) =>
  queryOptions({
    queryKey: askKey(householdId, 'valuables'),
    queryFn: async (): Promise<Valuable[]> => {
      const [things, places] = await Promise.all([
        supabase.from('v_asset').select('id, name, location_path').eq('household_id', householdId).eq('valuable', true).order('name'),
        supabase.from('location').select('id, name, path').eq('household_id', householdId).eq('valuable', true).order('path'),
      ]);
      if (things.error) throw things.error;
      if (places.error) throw places.error;
      return [
        ...places.data.map((p) => ({ kind: 'location' as const, id: p.id, name: p.name, path: p.path })),
        ...things.data.map((a) => ({ kind: 'asset' as const, id: a.id!, name: a.name ?? '', path: a.location_path })),
      ];
    },
    staleTime: 30 * 1000,
  });

export async function setValuable(householdId: string, kind: 'asset' | 'location', id: string, on: boolean) {
  const { error } = await supabase.rpc('rpc_set_valuable', { p_household: householdId, p_kind: kind, p_id: id, p_on: on });
  if (error) throw error;
}
