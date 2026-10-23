// What the household taught the matcher (Phase 9a): a shop / alert merchant → category and usual
// account, a printed bill name → category. Stored per household (merchant_memory, line_memory,
// migration 79) so the phone, the iPad and Sandeepani's devices all learn together; written only by
// rpc_memory_learn. Keys are bill_name_norm — the same as learned product names.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { Json } from '../db.types';
import { builtInCategory as sharedBuiltIn, payeeCategory as sharedPayee } from '@match/memory';
import type { CategoryRow } from '../money/categoriesMap';
import { moneyKey } from '../money/queries';
import { billNameNorm } from '../spine/normalise';
import { supabase } from '../supabase';

export interface Memory {
  merchants: Map<string, { category_id: string | null; account_id: string | null }>;
  lines: Map<string, string>;
  /** Phase 9b.1: the household's own payee → category choices (payee_category); defaults fill the rest. */
  payees: Map<string, string>;
}

export type LearnItem =
  | { kind: 'merchant'; text: string | null | undefined; category_id?: string | null; account_id?: string | null }
  | { kind: 'line'; text: string | null | undefined; category_id: string };

export const memoryQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'memory'),
    queryFn: async (): Promise<Memory> => {
      const [m, l, p] = await Promise.all([
        supabase.from('merchant_memory').select('merchant_norm, category_id, account_id').eq('household_id', householdId).limit(5000),
        supabase.from('line_memory').select('name_norm, category_id').eq('household_id', householdId).limit(5000),
        supabase.from('payee_category').select('payee_norm, category_id').eq('household_id', householdId).limit(500),
      ]);
      if (m.error) throw m.error;
      if (l.error) throw l.error;
      if (p.error) throw p.error;
      return {
        merchants: new Map(m.data.map((r) => [r.merchant_norm, { category_id: r.category_id, account_id: r.account_id }])),
        lines: new Map(l.data.map((r) => [r.name_norm, r.category_id])),
        payees: new Map(p.data.map((r) => [r.payee_norm, r.category_id])),
      };
    },
    staleTime: 5 * 60 * 1000,
  });

export function merchantMemory(memory: Memory | undefined, text: string | null | undefined) {
  const key = billNameNorm(text);
  return (key && memory?.merchants.get(key)) || null;
}

export function lineMemory(memory: Memory | undefined, name: string | null | undefined): string | null {
  const key = billNameNorm(name);
  return (key && memory?.lines.get(key)) || null;
}

/** Categories Gedara knows before anyone teaches it (shared with the match-agent run). */
export function builtInCategory(categories: CategoryRow[], text: string | null | undefined): string | null {
  return sharedBuiltIn(categories, text);
}

/** What a payee's confirmation says a payment was for (Phase 9b.1, shared with the match-agent run). */
export function payeeCategory(memory: Memory | undefined, categories: CategoryRow[], payee: string | null | undefined): string | null {
  return sharedPayee(categories, memory?.payees ?? new Map(), payee);
}

export async function savePayeeCategory(householdId: string, payee: string, categoryId: string) {
  const { error } = await supabase.rpc('rpc_payee_category_save', { p_household: householdId, p_payee: payee, p_category: categoryId });
  if (error) throw error;
}

export async function deletePayeeCategory(householdId: string, payeeNorm: string) {
  const { error } = await supabase.from('payee_category').delete().eq('household_id', householdId).eq('payee_norm', payeeNorm);
  if (error) throw error;
}

export async function learn(householdId: string, items: LearnItem[]): Promise<number> {
  const clean = items.filter((i) => billNameNorm(i.text) && (i.kind === 'line' || i.category_id || i.account_id));
  if (!clean.length) return 0;
  let learned = 0;
  for (let i = 0; i < clean.length; i += 300) {
    const { data, error } = await supabase.rpc('rpc_memory_learn', {
      p_household: householdId,
      p_items: clean.slice(i, i + 300) as unknown as Json,
    });
    if (error) throw error;
    learned += data;
  }
  return learned;
}

/** Learning never blocks or fails a save: it is a convenience on top of what was saved. */
export function learnSoon(qc: QueryClient | null, householdId: string, items: LearnItem[]) {
  void learn(householdId, items).then(
    (n) => n && qc && void qc.invalidateQueries({ queryKey: memoryQuery(householdId).queryKey }),
    () => undefined,
  );
}

// ── One-off: the per-device memories of Phases 2–8 move to the household ────
const LOCAL_KEYS = { category: 'gedara.sms.merchantCategory', account: 'gedara.money.merchantAccount' } as const;

function readLocal(key: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Sends this device's old localStorage memories to the household (once), then forgets them here. */
export async function migrateLocalMemories(
  householdId: string,
  categoryIds: Set<string>,
  accountIds: Set<string>,
): Promise<number> {
  const cats = readLocal(LOCAL_KEYS.category);
  const accs = readLocal(LOCAL_KEYS.account);
  if (!Object.keys(cats).length && !Object.keys(accs).length) return 0;
  const items: LearnItem[] = [
    // stale ids (a category or account deleted since) are left out rather than refused as a batch
    ...Object.entries(cats).filter(([, id]) => categoryIds.has(id)).map(([text, id]) => ({ kind: 'merchant' as const, text, category_id: id })),
    ...Object.entries(accs).filter(([, id]) => accountIds.has(id)).map(([text, id]) => ({ kind: 'merchant' as const, text, account_id: id })),
  ];
  const n = await learn(householdId, items);
  try {
    localStorage.removeItem(LOCAL_KEYS.category);
    localStorage.removeItem(LOCAL_KEYS.account);
  } catch {
    /* storage unavailable: nothing to forget */
  }
  return n;
}
