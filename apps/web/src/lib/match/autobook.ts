// Booking by itself (Phase 9c): what Gedara booked (match_autobook, read through RLS), Undo and
// "Looks right" (RPCs). The run decides and books inside the match-agent; the kinds and the bar live in
// the shared code (@match/book) so the switches here and the run agree.
import { queryOptions } from '@tanstack/react-query';
import type { AutoItem, AutoKind } from '@match/book';
import { moneyKey } from '../money/queries';
import { supabase } from '../supabase';

export interface AutoBooking {
  id: string;
  run_id: string | null;
  kind: AutoKind;
  action: 'link' | 'post' | 'seen' | 'line';
  sms_ids: string[];
  line_id: string | null;
  transaction_id: string | null;
  summary: AutoItem['summary'];
  created_at: string;
  undone_at: string | null;
  reviewed_at: string | null;
}

export const autobookQuery = (householdId: string) =>
  queryOptions({
    queryKey: moneyKey(householdId, 'match-autobook'),
    queryFn: async (): Promise<AutoBooking[]> => {
      const { data, error } = await supabase
        .from('match_autobook')
        .select('id, run_id, kind, action, sms_ids, line_id, transaction_id, summary, created_at, undone_at, reviewed_at')
        .eq('household_id', householdId)
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      return data as unknown as AutoBooking[];
    },
    staleTime: 30 * 1000,
  });

/** The bookings of one run together, newest run first. */
export function byRun(rows: AutoBooking[]): Array<{ key: string; at: string; items: AutoBooking[] }> {
  const groups = new Map<string, { key: string; at: string; items: AutoBooking[] }>();
  for (const r of rows) {
    const key = r.run_id ?? r.created_at.slice(0, 16);
    const g = groups.get(key) ?? { key, at: r.created_at, items: [] };
    g.items.push(r);
    if (r.created_at < g.at) g.at = r.created_at;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export async function undoAutobook(id: string) {
  const { error } = await supabase.rpc('rpc_match_autobook_undo', { p_id: id });
  if (error) throw error;
}

export async function autobookSeen(ids: string[]) {
  const { error } = await supabase.rpc('rpc_match_autobook_seen', { p_ids: ids });
  if (error) throw error;
}
