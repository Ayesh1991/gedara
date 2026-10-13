// The scale's log, live (Phase 6b, migration 68). Once the scale is built its USB port is sealed
// inside, so this is its Serial Monitor: the lines it sends with each sync ("[SCALE] steady: 1000.2 g",
// "[NET] Wi-Fi lost …"), newest first, last 7 days.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { deviceLogQuery, type DeviceLogLine } from '@/lib/scale/queries';
import { supabase } from '@/lib/supabase';

export function ScaleLog({ householdId, deviceId, timezone }: { householdId: string; deviceId: string; timezone: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const log = useQuery(deviceLogQuery(householdId, deviceId));

  useEffect(() => {
    const key = deviceLogQuery(householdId, deviceId).queryKey;
    const channel = supabase
      .channel(`scale-log-${deviceId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'device_log', filter: `device_id=eq.${deviceId}` }, (p) => {
        qc.setQueryData(key, (old: DeviceLogLine[] | undefined) => [p.new as DeviceLogLine, ...(old ?? [])].slice(0, 200));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void qc.invalidateQueries({ queryKey: key });
      });
    return () => void supabase.removeChannel(channel);
  }, [householdId, deviceId, qc]);

  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone });
  const lines = log.data ?? [];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="flex-1 font-display text-[19px] font-semibold">{t('scale.log.title')}</h2>
        <span className="text-[12px] text-faint">{t('scale.log.hint')}</span>
      </div>
      {lines.length === 0 ? (
        <p className="text-[14px] text-muted">{t('scale.log.empty')}</p>
      ) : (
        <ol className="max-h-[360px] overflow-y-auto rounded-xl bg-black/25 p-3 font-mono text-[12px] leading-relaxed" data-testid="scale-log">
          {lines.map((l) => (
            <li key={l.id} className="flex gap-3">
              <span className="tabular shrink-0 text-faint">{time.format(new Date(l.at))}</span>
              <span className={/fail|error|lost|can't|MISSING|404|401/i.test(l.line) ? 'text-caution' : 'text-[#c5cce3]'}>{l.line}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
