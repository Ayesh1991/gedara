// HL:LOT labels (migration 52): printing a lot's label gives it its code the first time
// (rpc_lot_code), then it never changes. The small line under the QR is the lot's date.
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { lotDueText } from './lotText';

export { lotDueText };

export interface LotLabel {
  id: string;
  code: string;
  name: string;
  due_date: string | null;
  due_type: string;
}

export const lotLabelsQuery = (lotIds: string[]) =>
  queryOptions({
    queryKey: ['lot-labels', lotIds.join(',')],
    queryFn: async (): Promise<LotLabel[]> => {
      const codes = await Promise.all(
        lotIds.map(async (id) => {
          const { data, error } = await supabase.rpc('rpc_lot_code', { p_lot: id });
          if (error) throw error;
          return [id, data as string] as const;
        }),
      );
      const { data, error } = await supabase
        .from('stock_lot')
        .select('id, due_date, product:product!stock_lot_household_id_product_id_fkey (name, due_type)')
        .in('id', lotIds);
      if (error) throw error;
      const byId = new Map(codes);
      return data.flatMap((l) =>
        l.product && byId.get(l.id)
          ? [{ id: l.id, code: byId.get(l.id)!, name: l.product.name, due_date: l.due_date, due_type: l.product.due_type }]
          : [],
      );
    },
    staleTime: Infinity,
  });
