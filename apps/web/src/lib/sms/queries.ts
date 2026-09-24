// Bank-SMS inbox data access. Reads straight from the tables/views (RLS); writes are RPCs, and the
// SMS-backup upload goes through the sms-ingest Edge Function (the same parser as the phone path).
import { queryOptions } from '@tanstack/react-query';
import { env } from '../env';
import { supabase } from '../supabase';
import type { Json } from '../db.types';
import { moneyKey, type SavePayload } from '../money/queries';
import type { BackupSms } from './backupXml';
import type { SmsRow, TxCandidate } from './match';

const SMS_COLUMNS = `id, sender, body, received_at, fingerprint, kind, institution, last_digits, account_id, amount,
  currency, balance_after, merchant_text, occurred_on, occurred_at, transaction_id, ignored, reviewed_at, channel`;

export type InboxRow = SmsRow & { reviewed_at: string | null; channel: string };

/** Every alert (a household gets a few hundred a year); the page splits new / reviewed. */
export const smsQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'sms'),
    queryFn: async (): Promise<InboxRow[]> => {
      const { data, error } = await supabase
        .from('sms_message')
        .select(SMS_COLUMNS)
        .eq('household_id', householdId)
        .order('received_at', { ascending: false })
        .limit(3000);
      if (error) throw error;
      return data as InboxRow[];
    },
    staleTime: 30 * 1000,
  });

/** Expenses, income and transfers around the new alerts' dates — what they might already be. */
export const smsCandidatesQuery = (householdId: string, from: string | null, to: string | null) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'sms-candidates', from, to),
    enabled: !!from && !!to,
    queryFn: async (): Promise<TxCandidate[]> => {
      const { data, error } = await supabase
        .from('money_transaction')
        .select('id, type, account_id, to_account_id, payee_text, occurred_on, occurred_at, total')
        .eq('household_id', householdId)
        .in('type', ['expense', 'income', 'refund', 'transfer'])
        .is('related_id', null)
        .gte('occurred_on', from!)
        .lte('occurred_on', to!)
        .limit(3000);
      if (error) throw error;
      return data;
    },
    staleTime: 30 * 1000,
  });

export interface BalanceCheck {
  account_id: string;
  bank_reported: number;
  reported_at: string;
  gedara_value: number | null;
  is_set_up: boolean;
}

export const smsBalanceQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'sms-balance'),
    queryFn: async (): Promise<Map<string, BalanceCheck>> => {
      const { data, error } = await supabase
        .from('v_sms_balance_check')
        .select('account_id, bank_reported, reported_at, gedara_value, is_set_up')
        .eq('household_id', householdId);
      if (error) throw error;
      return new Map((data as BalanceCheck[]).map((r) => [r.account_id, r]));
    },
    staleTime: 30 * 1000,
  });

export interface Device {
  id: string;
  name: string;
  token_hint: string;
  created_at: string;
  last_seen_at: string | null;
  message_count: number;
  dropped_count: number;
  last_rejected_sender: string | null;
  last_rejected_at: string | null;
  revoked_at: string | null;
}

export const devicesQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['sms-devices', householdId],
    queryFn: async (): Promise<Device[]> => {
      const { data, error } = await supabase
        .from('sms_device')
        .select(
          'id, name, token_hint, created_at, last_seen_at, message_count, dropped_count, last_rejected_sender, last_rejected_at, revoked_at',
        )
        .eq('household_id', householdId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    staleTime: 15 * 1000,
  });

// ── Writes ────────────────────────────────────────────────────────────────────

export async function smsLink(smsIds: string[], transactionId: string): Promise<{ moved: boolean }> {
  const { data, error } = await supabase.rpc('rpc_sms_link', { p_sms_ids: smsIds, p_transaction: transactionId });
  if (error) throw error;
  return data as { moved: boolean };
}

/** Creates the transaction the alerts describe (fingerprint = the earliest alert's, source 'sms'). */
export async function smsPost(smsIds: string[], p: Omit<SavePayload, 'id' | 'fingerprint'>): Promise<{ id: string }> {
  const { data, error } = await supabase.rpc('rpc_sms_post', { p_sms_ids: smsIds, p: p as unknown as Json });
  if (error) throw error;
  return data as { id: string };
}

export async function smsIgnore(ids: string[], ignored: boolean): Promise<number> {
  const { data, error } = await supabase.rpc('rpc_sms_ignore', { p_ids: ids, p_ignored: ignored });
  if (error) throw error;
  return data;
}

export async function smsUnlink(ids: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('rpc_sms_unlink', { p_ids: ids });
  if (error) throw error;
  return data;
}

export async function createDevice(householdId: string, name: string): Promise<{ id: string; token: string }> {
  const { data, error } = await supabase.rpc('rpc_sms_device_create', { p_household: householdId, p_name: name });
  if (error) throw error;
  return data as { id: string; token: string };
}

export async function revokeDevice(id: string) {
  const { error } = await supabase.rpc('rpc_sms_device_revoke', { p_id: id });
  if (error) throw error;
}

export interface BackupUploadResult {
  stored: number;
  duplicate: number;
  dropped: number;
  filtered: Record<string, number>;
}

/** Uploads backup alerts in batches of 200 through sms-ingest (parsed + filtered server-side too). */
export async function uploadBackup(
  householdId: string,
  messages: BackupSms[],
  onProgress?: (done: number) => void,
): Promise<BackupUploadResult> {
  const total: BackupUploadResult = { stored: 0, duplicate: 0, dropped: 0, filtered: {} };
  for (let i = 0; i < messages.length; i += 200) {
    const batch = messages.slice(i, i + 200);
    const { data, error } = await supabase.functions.invoke('sms-ingest', {
      body: { household_id: householdId, messages: batch },
    });
    if (error) throw error;
    const r = data as BackupUploadResult & { ok: boolean };
    total.stored += r.stored;
    total.duplicate += r.duplicate;
    total.dropped += r.dropped;
    for (const [k, v] of Object.entries(r.filtered ?? {})) total.filtered[k] = (total.filtered[k] ?? 0) + v;
    onProgress?.(Math.min(i + 200, messages.length));
  }
  return total;
}

/** The ingest URL the phone posts to. */
export function ingestUrl(): string {
  return `${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/sms-ingest`;
}

// ── Per-device convenience: the category last used for a merchant's alerts ────
const MERCHANT_CATEGORY = 'gedara.sms.merchantCategory';

export function categoryForMerchant(merchant: string | null | undefined): string | null {
  if (!merchant) return null;
  try {
    const map = JSON.parse(localStorage.getItem(MERCHANT_CATEGORY) ?? '{}') as Record<string, string>;
    return map[merchant.toLowerCase().trim()] ?? null;
  } catch {
    return null;
  }
}

export function rememberCategory(merchant: string | null | undefined, categoryId: string) {
  if (!merchant) return;
  try {
    const map = JSON.parse(localStorage.getItem(MERCHANT_CATEGORY) ?? '{}') as Record<string, string>;
    map[merchant.toLowerCase().trim()] = categoryId;
    localStorage.setItem(MERCHANT_CATEGORY, JSON.stringify(map));
  } catch {
    /* storage unavailable: nothing remembered */
  }
}
