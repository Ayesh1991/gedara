import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gem } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Toggle } from '@/components/ui/toggle';
import { invalidateAsk, setValuable } from '@/lib/ask/queries';
import { supabase } from '@/lib/supabase';

/**
 * The owner's "Valuable" switch on a thing or a place (Phase 10, migration 98). A valuable thing stays
 * visible to the household without its place, photos or receipts; a valuable place and everything in it is
 * the owner's only. Ask Gedara never shows either, not even to the owner.
 */
export function ValuableSwitch({ householdId, kind, id, on: known }: { householdId: string; kind: 'asset' | 'location'; id: string; on?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // a place's flag isn't in the shared places list, so it is read here (the owner only renders this)
  const place = useQuery({
    queryKey: ['places', householdId, 'valuable', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('location').select('valuable').eq('id', id).single();
      if (error) throw error;
      return data.valuable;
    },
    enabled: kind === 'location',
  });
  const on = kind === 'location' ? !!place.data : !!known;

  async function change(next: boolean) {
    setBusy(true);
    try {
      await setValuable(householdId, kind, id, next);
      toast.success(t(next ? 'ask.valuable.on' : 'ask.valuable.off'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['things', householdId] }),
        qc.invalidateQueries({ queryKey: ['places', householdId] }),
        invalidateAsk(qc, householdId),
      ]);
    } catch {
      toast.error(t('ask.errors.unknown'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line bg-white/[0.03] p-3">
      <Gem className="mt-0.5 h-5 w-5 shrink-0 text-violet" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-medium">{t('ask.valuable.label')}</div>
        <p className="text-[12.5px] text-muted">{t(kind === 'asset' ? 'ask.valuable.thingHint' : 'ask.valuable.placeHint')}</p>
      </div>
      <Toggle on={on} disabled={busy || (kind === 'location' && !place.data && place.isPending)} label={t('ask.valuable.label')} onChange={(v) => void change(v)} />
    </div>
  );
}
