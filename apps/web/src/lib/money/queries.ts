// Money data access. Reads go straight to the tables/views (RLS); every write is an RPC
// (CLAUDE.md rule 1 — balances only ever change by writing transactions).
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { isPendingDelete } from '../undo';
import { monthRange } from '../time';
import type { Json, Tables } from '../db.types';
import type { CategoryRow } from './categoriesMap';
import { toRpcBill, type ImportBill } from './billSchema';

export const ACCOUNT_KINDS = ['cash', 'bank', 'credit_card', 'wallet', 'loan', 'investment'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const TX_TYPES = ['expense', 'income', 'transfer', 'refund', 'adjustment'] as const;
export type TxType = (typeof TX_TYPES)[number];

export type AccountRow = Tables<'account'>;
export interface Account extends AccountRow {
  balance: number;
  available: number | null;
  transactionCount: number;
  lastOn: string | null;
  isSetUp: boolean;
}

export type Line = Pick<
  Tables<'transaction_line'>,
  | 'id' | 'line_no' | 'raw_name' | 'category_id' | 'qty' | 'unit_text' | 'unit_price' | 'amount' | 'base_qty'
  | 'price_per_base' | 'unit_id' | 'fingerprint' | 'destiny' | 'product_id'
>;
export type Transaction = Pick<
  Tables<'money_transaction'>,
  | 'id' | 'household_id' | 'type' | 'account_id' | 'to_account_id' | 'merchant_id' | 'payee_text' | 'occurred_on'
  | 'occurred_at' | 'invoice_no' | 'subtotal' | 'discount' | 'total' | 'source' | 'fingerprint' | 'related_id'
  | 'notes' | 'created_at'
> & { lines: Line[] };

const LINE_COLUMNS =
  'id, line_no, raw_name, category_id, qty, unit_text, unit_price, amount, base_qty, price_per_base, unit_id, fingerprint, destiny, product_id';
const TX_COLUMNS = `id, household_id, type, account_id, to_account_id, merchant_id, payee_text, occurred_on, occurred_at,
  invoice_no, subtotal, discount, total, source, fingerprint, related_id, notes, created_at,
  transaction_line (${LINE_COLUMNS})`;

type TxRow = Omit<Transaction, 'lines'> & { transaction_line: Line[] };
const toTx = (r: TxRow): Transaction => {
  const { transaction_line, ...rest } = r;
  return { ...rest, lines: [...transaction_line].sort((a, b) => a.line_no - b.line_no) };
};

// Every money query key starts with ['money', householdId] so one invalidation refreshes them all.
export const moneyKey = (householdId: string, ...rest: unknown[]) => ['money', householdId, ...rest] as const;

export function invalidateMoney(qc: QueryClient, householdId: string) {
  return qc.invalidateQueries({ queryKey: ['money', householdId] });
}

export const accountsQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'accounts'),
    queryFn: async (): Promise<Account[]> => {
      const [accounts, balances] = await Promise.all([
        supabase.from('account').select('*').eq('household_id', householdId).order('sort').order('name'),
        supabase.from('v_account_balance').select('*').eq('household_id', householdId),
      ]);
      if (accounts.error) throw accounts.error;
      if (balances.error) throw balances.error;
      const byId = new Map(balances.data.map((b) => [b.account_id, b]));
      return accounts.data.map((a) => {
        const b = byId.get(a.id);
        return {
          ...a,
          balance: b?.balance ?? a.opening_balance,
          available: b?.available ?? null,
          transactionCount: b?.transaction_count ?? 0,
          lastOn: b?.last_on ?? null,
          isSetUp: a.opening_on !== null,
        };
      });
    },
    staleTime: 30 * 1000,
  });

export const categoriesQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'categories'),
    queryFn: async (): Promise<CategoryRow[]> => {
      const { data, error } = await supabase
        .from('category')
        .select('id, parent_id, key, name, kind, sort, archived, icon, color, default_destiny')
        .eq('household_id', householdId)
        .order('sort');
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

/** Unit id → code ('kg', 'pcs' …) for showing Rs per kg / L. */
export const unitsQuery = queryOptions({
  queryKey: ['units'],
  queryFn: async (): Promise<Map<string, string>> => {
    const { data, error } = await supabase.from('unit').select('id, code');
    if (error) throw error;
    return new Map(data.map((u) => [u.id, u.code]));
  },
  staleTime: 60 * 60 * 1000,
});

export const merchantsQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'merchants'),
    queryFn: async () => {
      const { data, error } = await supabase.from('merchant').select('id, name').eq('household_id', householdId).order('name');
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

/** One calendar month ('YYYY-MM') of transactions, newest first, with their lines. */
export const monthTransactionsQuery = (householdId: string, month: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'month', month),
    queryFn: async (): Promise<Transaction[]> => {
      const { start, end } = monthRange(month);
      const { data, error } = await supabase
        .from('money_transaction')
        .select(TX_COLUMNS)
        .eq('household_id', householdId)
        .gte('occurred_on', start)
        .lt('occurred_on', end)
        .order('occurred_on', { ascending: false })
        .order('occurred_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data as unknown as TxRow[]).map(toTx).filter((t) => !isPendingDelete(t.id));
    },
    staleTime: 30 * 1000,
  });

/** An account's history (either side of a transfer), newest first. */
export const accountTransactionsQuery = (householdId: string, accountId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'account-tx', accountId),
    queryFn: async (): Promise<Transaction[]> => {
      const { data, error } = await supabase
        .from('money_transaction')
        .select(TX_COLUMNS)
        .eq('household_id', householdId)
        .or(`account_id.eq.${accountId},to_account_id.eq.${accountId}`)
        .order('occurred_on', { ascending: false })
        .order('occurred_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return (data as unknown as TxRow[]).map(toTx).filter((t) => !isPendingDelete(t.id));
    },
    staleTime: 30 * 1000,
  });

export const transactionQuery = (householdId: string, id: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'tx', id),
    queryFn: async (): Promise<{ tx: Transaction | null; fee: Transaction | null }> => {
      const [one, fee] = await Promise.all([
        supabase.from('money_transaction').select(TX_COLUMNS).eq('id', id).maybeSingle(),
        supabase.from('money_transaction').select(TX_COLUMNS).eq('related_id', id).maybeSingle(),
      ]);
      if (one.error) throw one.error;
      if (fee.error) throw fee.error;
      return {
        tx: one.data ? toTx(one.data as unknown as TxRow) : null,
        fee: fee.data ? toTx(fee.data as unknown as TxRow) : null,
      };
    },
    staleTime: 30 * 1000,
  });

export interface MonthFlow {
  month: string; // 'YYYY-MM'
  income: number;
  spent: number;
  net: number;
  bills: number;
}

export const cashflowQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'cashflow'),
    queryFn: async (): Promise<MonthFlow[]> => {
      const { data, error } = await supabase
        .from('v_monthly_cashflow')
        .select('month, income, spent, net, bills')
        .eq('household_id', householdId)
        .order('month');
      if (error) throw error;
      return data.map((r) => ({
        month: (r.month ?? '').slice(0, 7),
        income: r.income ?? 0,
        spent: r.spent ?? 0,
        net: r.net ?? 0,
        bills: r.bills ?? 0,
      }));
    },
    staleTime: 30 * 1000,
  });

/** Which of these transaction fingerprints already exist (for "Already imported"). */
export async function existingFingerprints(householdId: string, fps: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < fps.length; i += 100) {
    const { data, error } = await supabase
      .from('money_transaction')
      .select('fingerprint')
      .eq('household_id', householdId)
      .in('fingerprint', fps.slice(i, i + 100));
    if (error) throw error;
    for (const r of data) found.add(r.fingerprint);
  }
  return found;
}

/** Sum of imported line amounts per month, looked up by line fingerprint (Sheet reconciliation). */
export async function linesByMonth(lineFps: string[]): Promise<{ months: Map<string, number>; found: number }> {
  const cents = new Map<string, number>();
  let found = 0;
  for (let i = 0; i < lineFps.length; i += 100) {
    const { data, error } = await supabase
      .from('transaction_line')
      .select('amount, money_transaction!inner (occurred_on)')
      .in('fingerprint', lineFps.slice(i, i + 100));
    if (error) throw error;
    for (const r of data as unknown as Array<{ amount: number; money_transaction: { occurred_on: string } }>) {
      const m = r.money_transaction.occurred_on.slice(0, 7);
      cents.set(m, (cents.get(m) ?? 0) + Math.round(r.amount * 100));
      found++;
    }
  }
  return { months: new Map([...cents].map(([m, c]) => [m, c / 100])), found };
}

// ── Writes ────────────────────────────────────────────────────────────────────

export interface SaveLine {
  raw_name: string;
  category_id: string | null;
  qty?: number | null;
  unit_text?: string | null;
  unit_price?: number | null;
  amount: number;
  fingerprint: string;
}

export interface SavePayload {
  id?: string;
  household_id: string;
  type: TxType;
  account_id: string;
  to_account_id?: string | null;
  payee_text?: string | null;
  occurred_on: string;
  occurred_at?: string | null;
  invoice_no?: string | null;
  notes?: string | null;
  total: number;
  fingerprint?: string;
  lines: SaveLine[];
  /** Editing a bill whose lines feed the pantry: change the header only. */
  keep_lines?: boolean;
  fee?: { amount: number; category_id: string | null } | null;
}

export async function saveTransaction(p: SavePayload): Promise<{ id: string; fingerprint: string }> {
  const { data, error } = await supabase.rpc('rpc_save_transaction', { p: p as unknown as Json });
  if (error) throw error;
  return data as { id: string; fingerprint: string };
}

export interface ImportResult {
  fingerprint: string;
  status: 'imported' | 'duplicate';
  id: string | null;
  /** Lots created, list items ticked and the correlation of the bill's purchases (Phase 4). */
  lots?: number;
  ticked?: number;
  correlation_id?: string | null;
}

/** Sends bills in batches (the RPC takes ≤ 200); `onProgress` gets the number done so far. */
export async function importBills(
  householdId: string,
  bills: ImportBill[],
  onProgress?: (done: number) => void,
  batchSize = 25,
): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (let i = 0; i < bills.length; i += batchSize) {
    const batch = bills.slice(i, i + batchSize).map(toRpcBill);
    const { data, error } = await supabase.rpc('rpc_import_bills', {
      p_household: householdId,
      p_bills: batch as unknown as Json,
    });
    if (error) throw error;
    out.push(...(data as unknown as ImportResult[]));
    onProgress?.(Math.min(i + batchSize, bills.length));
  }
  return out;
}

/**
 * Deletes a transaction. A bill's pantry stock is taken back with it (GDUSE when some was used
 * since); `keepStock` deletes the bill and leaves its lots in the pantry.
 */
export async function deleteTransaction(id: string, keepStock = false) {
  const { error } = await supabase.rpc('rpc_delete_transaction', { p_id: id, p_keep_stock: keepStock });
  if (error) throw error;
}

export async function moveTransactions(ids: string[], accountId: string): Promise<number> {
  const { data, error } = await supabase.rpc('rpc_move_transactions', { p_ids: ids, p_account: accountId });
  if (error) throw error;
  return data;
}

export interface AccountInput {
  name: string;
  kind: AccountKind;
  institution: string | null;
  last4: string | null;
  credit_limit: number | null;
}

export async function createAccount(householdId: string, input: AccountInput) {
  const { error } = await supabase.from('account').insert({ household_id: householdId, ...input });
  if (error) throw error;
}

export async function updateAccount(
  id: string,
  patch: Partial<Omit<AccountInput, 'kind'>> & { archived?: boolean; opening_balance?: number; opening_on?: string | null },
) {
  const { error } = await supabase.from('account').update(patch).eq('id', id);
  if (error) throw error;
}

/** Postgres / RPC error → i18n key suffix under money.errors. */
export function moneyErrorKey(
  e: unknown,
): 'duplicate' | 'invalid' | 'reference' | 'denied' | 'nameTaken' | 'reviewed' | 'routed' | 'stockUsed' | 'unitMismatch' | 'generic' {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'GDDUP') return 'duplicate';
  if (code === 'GDRTD') return 'routed';
  if (code === 'GDUSE') return 'stockUsed';
  if (code === 'GDUNT') return 'unitMismatch';
  if (code === 'GDLNK') return 'reviewed';
  if (code === '23514') return 'invalid';
  if (code === '23503') return 'reference';
  if (code === '42501') return 'denied';
  if (code === '23505') return 'nameTaken';
  return 'generic';
}

// ── Small per-device conveniences (never needed for correctness) ─────────────

const LAST_ACCOUNT = 'gedara.money.lastAccount';
const MERCHANT_ACCOUNT = 'gedara.money.merchantAccount';

export function lastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT);
  } catch {
    return null;
  }
}

export function rememberAccount(accountId: string, merchant?: string | null) {
  try {
    localStorage.setItem(LAST_ACCOUNT, accountId);
    if (merchant) {
      const map = JSON.parse(localStorage.getItem(MERCHANT_ACCOUNT) ?? '{}') as Record<string, string>;
      map[merchant.toLowerCase().trim()] = accountId;
      localStorage.setItem(MERCHANT_ACCOUNT, JSON.stringify(map));
    }
  } catch {
    /* storage unavailable: defaults just aren't remembered */
  }
}

export function accountForMerchant(merchant: string | null | undefined): string | null {
  if (!merchant) return null;
  try {
    const map = JSON.parse(localStorage.getItem(MERCHANT_ACCOUNT) ?? '{}') as Record<string, string>;
    return map[merchant.toLowerCase().trim()] ?? null;
  } catch {
    return null;
  }
}

/** Accounts you can pick for a new entry: not archived, not the "to be matched" bucket. */
export function pickableAccounts(accounts: Account[] | undefined, keep?: string | null): Account[] {
  return (accounts ?? []).filter((a) => (!a.archived && !a.is_suspense) || a.id === keep);
}

export async function createCategory(householdId: string, parentId: string, name: string) {
  const { error } = await supabase.from('category').insert({ household_id: householdId, parent_id: parentId, name: name.trim() });
  if (error) throw error;
}

export async function updateCategory(id: string, patch: { name?: string; icon?: string | null; color?: string | null; archived?: boolean }) {
  const { error } = await supabase.from('category').update(patch).eq('id', id);
  if (error) throw error;
}
