// Sending a command to Home Assistant from a tile: the tile changes at once (optimistic), the
// command goes through rpc_home_command, and the screen waits for the bridge to say Home Assistant
// did it. If it refused or didn't answer, the tile goes back to the truth and a toast says why.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { HomeAction } from '@home/protocol';
import {
  entitiesQuery,
  homeErrorKey,
  invalidateHome,
  optimistic,
  sendHomeCommand,
  waitForHomeCommand,
  type HomeEntity,
} from '@/lib/home/queries';

export function useHomeControl(householdId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const act = useCallback(
    async (e: HomeEntity, action: HomeAction, args: Record<string, unknown> = {}) => {
      const key = entitiesQuery(householdId).queryKey;
      setBusy((s) => new Set(s).add(e.id));
      qc.setQueryData(key, (old: HomeEntity[] | undefined) => (old ?? []).map((x) => (x.id === e.id ? optimistic(x, action, args) : x)));
      try {
        const id = await sendHomeCommand(e.id, action, args);
        const r = await waitForHomeCommand(id);
        if (r.outcome !== 'done') {
          await invalidateHome(qc, householdId, 'entities');
          toast.error(r.outcome === 'failed' ? t('house.errors.failed', { why: r.error ?? '' }) : t('house.errors.noAnswer'));
        }
      } catch (err) {
        await invalidateHome(qc, householdId, 'entities');
        toast.error(t(homeErrorKey(err)));
      } finally {
        setBusy((s) => {
          const n = new Set(s);
          n.delete(e.id);
          return n;
        });
      }
    },
    [householdId, qc, t],
  );

  return { act, busy };
}
