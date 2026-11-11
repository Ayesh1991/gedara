// "Add with a bill guard", the bill side (Phase 11, Didula 2026-11-10). Right after a bill stocked
// the pantry, packs that the bin scanner's Add had already put in (in the 3 days before the bill)
// are taken off again in the database (rpc_bin_add_settle), so nothing is counted twice; the bill's
// lot keeps the price. The app says so with a toast that has Undo (components/scanner/ScannerPopups).
// Best effort: a bill import never fails because of this. Only imports `supabase`, so the money and
// spine queries can call it without an import cycle.
import { supabase } from '../supabase';

export const SETTLED_EVENT = 'gedara-bin-settled';

export interface SettledDetail {
  correlation_id: string;
  items: { product_id: string; name: string; qty: number; unit: string }[];
}

export async function settleAfterBills(transactionIds: (string | null | undefined)[]): Promise<void> {
  for (const id of transactionIds) {
    if (!id) continue;
    try {
      const { data, error } = await supabase.rpc('rpc_bin_add_settle', { p_transaction: id });
      if (error) continue;
      const d = data as unknown as { correlation_id: string | null; items: SettledDetail['items'] } | null;
      if (d?.correlation_id && d.items.length > 0 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<SettledDetail>(SETTLED_EVENT, { detail: { correlation_id: d.correlation_id, items: d.items } }));
      }
    } catch {
      // offline or an older database: the bill is saved either way
    }
  }
}
