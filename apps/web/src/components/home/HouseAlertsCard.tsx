// Settings › Notifications › House alerts (Phase 8b): each person chooses for themselves whether a
// door or window opening, and someone being detected, sends a notification to their phones — off,
// always, or only at night (their own night). Only once the Home Assistant bridge is connected.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { alertPrefQuery, bridgeQuery, homeErrorKey, setAlertPref, type AlertPref, type AlertWhen } from '@/lib/home/queries';
import { cn } from '@/lib/utils';

const WHEN: AlertWhen[] = ['off', 'always', 'night'];

export function HouseAlertsCard({ householdId, phoneOn }: { householdId: string; phoneOn: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bridge = useQuery(bridgeQuery(householdId));
  const pref = useQuery({ ...alertPrefQuery(householdId), enabled: !!bridge.data });
  const [busy, setBusy] = useState(false);
  if (!bridge.data || !pref.data) return null;
  const p = pref.data;

  async function save(change: Partial<AlertPref>) {
    setBusy(true);
    const key = alertPrefQuery(householdId).queryKey;
    qc.setQueryData(key, { ...p, ...change });
    try {
      const r = await setAlertPref(householdId, change);
      qc.setQueryData(key, r);
    } catch (e) {
      toast.error(t(homeErrorKey(e)));
      await qc.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
    }
  }

  const choice = (what: 'doors' | 'presence') => (
    <div className="flex flex-col gap-2">
      <span className="text-[14.5px]">{t(`house.alerts.${what}`)}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t(`house.alerts.${what}`)}>
        {WHEN.map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={p[what] === w}
            disabled={busy}
            onClick={() => p[what] !== w && void save({ [what]: w })}
            data-testid={`alert-${what}-${w}`}
            className={cn(
              'h-9 rounded-full border px-3.5 text-[13.5px] disabled:opacity-60',
              p[what] === w ? 'border-accent-b/60 bg-accent-b/15 text-text' : 'border-line-2 text-muted hover:text-text',
            )}
          >
            {t(`house.alerts.when.${w}`)}
          </button>
        ))}
      </div>
    </div>
  );

  const night = p.doors === 'night' || p.presence === 'night';
  return (
    <Card className="flex flex-col gap-4" data-testid="house-alerts">
      <div>
        <h2 className="font-display text-[17px] font-semibold">{t('house.alerts.title')}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{t('house.alerts.intro')}</p>
      </div>
      {choice('doors')}
      {choice('presence')}
      {night && (
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="text-muted">{t('house.alerts.night')}</span>
          <input
            type="time"
            value={p.night_from}
            aria-label={t('house.alerts.nightFrom')}
            disabled={busy}
            onChange={(e) => e.target.value && void save({ night_from: e.target.value })}
            className="tabular glass h-10 rounded-xl px-3 font-mono"
          />
          <span className="text-muted">–</span>
          <input
            type="time"
            value={p.night_to}
            aria-label={t('house.alerts.nightTo')}
            disabled={busy}
            onChange={(e) => e.target.value && void save({ night_to: e.target.value })}
            className="tabular glass h-10 rounded-xl px-3 font-mono"
          />
        </div>
      )}
      {(p.doors !== 'off' || p.presence !== 'off') && !phoneOn && <p className="text-[13.5px] text-caution">{t('house.alerts.phoneOff')}</p>}
      <p className="text-[12.5px] text-faint">{t('house.alerts.note')}</p>
    </Card>
  );
}
