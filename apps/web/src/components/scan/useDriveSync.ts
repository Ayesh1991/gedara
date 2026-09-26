import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { attentionKey } from '@/lib/insights/queries';
import { invalidateScan, syncDrive } from '@/lib/scan/queries';

/** Look for new scanner files when a screen opens (the database throttles it to once per 5 minutes). */
export function useDriveSync(householdId: string, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !navigator.onLine) return;
    let alive = true;
    void syncDrive(householdId).then((r) => {
      if (!alive || !(r.stored || r.error)) return;
      void invalidateScan(qc, householdId);
      void qc.invalidateQueries({ queryKey: attentionKey(householdId) });
    });
    return () => {
      alive = false;
    };
  }, [qc, householdId, enabled]);
}
