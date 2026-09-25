import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { invalidateShopping, shoppingListQuery, syncShopping } from '@/lib/spine/queries';

/**
 * The shopping list, kept up to date: below-minimum products are synced in when a screen that
 * shows the list opens, and changes from the other phone arrive live (Realtime, RLS applies).
 */
export function useShoppingList(householdId: string, canWrite: boolean, live = false) {
  const qc = useQueryClient();
  const list = useQuery(shoppingListQuery(householdId));

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    syncShopping(householdId).then(
      (r) => !cancelled && (r.added || r.removed) && void invalidateShopping(qc, householdId),
      () => undefined, // best effort: the list still shows what's there
    );
    return () => {
      cancelled = true;
    };
  }, [householdId, canWrite, qc]);

  useEffect(() => {
    if (!live) return;
    const channel = supabase
      .channel(`shopping-${householdId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shopping_list_item', filter: `household_id=eq.${householdId}` },
        () => void invalidateShopping(qc, householdId),
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [householdId, live, qc]);

  return list;
}
