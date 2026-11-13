// A scanned bill arriving after the same cash spend was entered in Quick spend (Phase 12) would
// count it twice. After an import, a bill paid from a cash wallet whose total equals a quick entry
// from a cash wallet within a day either side is offered as "the same?": keep the bill (it has the
// items) and remove the quick entry, or keep both. Same rule as alert + bill (decision 2026-10-26).
import { supabase } from '../supabase';

export interface TwinBill {
  id: string;
  total: number;
  occurred_on: string;
}
export interface TwinEntry {
  transaction_id: string;
  total: number;
  occurred_on: string;
  name: string;
}
export interface Twin {
  bill: TwinBill;
  entry: TwinEntry;
}

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/** Each bill with the nearest unclaimed quick entry of exactly its total, at most a day apart. Pure. */
export function matchTwins(bills: readonly TwinBill[], entries: readonly TwinEntry[]): Twin[] {
  const used = new Set<string>();
  const out: Twin[] = [];
  for (const bill of bills) {
    const best = entries
      .filter((e) => !used.has(e.transaction_id) && e.transaction_id !== bill.id)
      .filter((e) => Math.round(e.total * 100) === Math.round(bill.total * 100) && days(e.occurred_on, bill.occurred_on) <= 1)
      .sort((a, b) => days(a.occurred_on, bill.occurred_on) - days(b.occurred_on, bill.occurred_on))[0];
    if (best) {
      used.add(best.transaction_id);
      out.push({ bill, entry: best });
    }
  }
  return out;
}

/** Quick entries from cash wallets around these bills' dates (one request, only after an import). */
export async function findTwins(householdId: string, bills: TwinBill[], cashAccountIds: string[]): Promise<Twin[]> {
  if (bills.length === 0 || cashAccountIds.length === 0) return [];
  const dates = bills.map((b) => b.occurred_on).sort();
  const shift = (d: string, by: number) => new Date(Date.parse(`${d}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('quick_entry')
    .select('transaction_id, money_transaction!inner (id, total, occurred_on, account_id, type, transaction_line (raw_name, line_no))')
    .eq('household_id', householdId)
    .not('transaction_id', 'is', null)
    .eq('money_transaction.type', 'expense')
    .in('money_transaction.account_id', cashAccountIds)
    .gte('money_transaction.occurred_on', shift(dates[0]!, -1))
    .lte('money_transaction.occurred_on', shift(dates.at(-1)!, 1));
  if (error) throw error;
  type Row = { transaction_id: string; money_transaction: { total: number; occurred_on: string; transaction_line: Array<{ raw_name: string; line_no: number }> } };
  const entries = (data as unknown as Row[]).map((r) => ({
    transaction_id: r.transaction_id,
    total: r.money_transaction.total,
    occurred_on: r.money_transaction.occurred_on,
    name: [...r.money_transaction.transaction_line].sort((a, b) => a.line_no - b.line_no)[0]?.raw_name ?? '',
  }));
  return matchTwins(bills, entries);
}
