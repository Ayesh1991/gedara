import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, Gem, MapPin, Package, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { askStatusQuery, invalidateAsk, saveAskSettings, valuablesQuery } from '@/lib/ask/queries';

export const Route = createFileRoute('/_app/settings/ask')({
  component: AskSettingsPage,
});

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/**
 * Settings › Ask Gedara (Phase 10): the owner's switch (off by default) and each person's daily limit;
 * everyone sees how it keeps data safe, today's count and this month's AI cost (shared with Matching). The
 * owner also sees the list of valuables (marked on the thing's or the place's own page).
 */
function AskSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const isOwner = membership.role === 'owner';
  const status = useQuery(askStatusQuery(householdId));
  const valuables = useQuery({ ...valuablesQuery(householdId), enabled: isOwner });
  const [limit, setLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  async function save(p: { ask_enabled?: boolean; ask_daily_per_person?: number }) {
    setBusy(true);
    try {
      await saveAskSettings(householdId, p);
      toast.success(t('ask.settings.saved'));
      setLimit(null);
      await invalidateAsk(qc, householdId);
    } catch {
      toast.error(t('ask.errors.unknown'));
    } finally {
      setBusy(false);
    }
  }

  const limitValue = limit ?? String(s?.limit ?? 20);
  const limitNumber = Number(limitValue);
  const limitOk = /^\d{1,3}$/.test(limitValue) && limitNumber >= 0 && limitNumber <= 100;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('ask.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('ask.intro')}</p>
      </div>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 shrink-0 text-info" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('ask.settings.switchTitle')}</div>
            <div className="text-[13px] text-muted">{t(s?.enabled ? 'ask.settings.switchOn' : 'ask.settings.switchOffHint')}</div>
          </div>
          <Toggle on={!!s?.enabled} disabled={!isOwner || busy || !s} label={t('ask.settings.switchTitle')} onChange={(on) => void save({ ask_enabled: on })} />
        </div>
        {!isOwner && <p className="text-[12.5px] text-muted">{t('ask.settings.ownerOnly')}</p>}
        {s && (
          <p className="text-[13px] text-muted">
            <span className="tabular font-mono">{t('ask.settings.today', { used: s.used, limit: s.limit })}</span>
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <label htmlFor="ask-limit" className="font-medium">
          {t('ask.settings.limit')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="ask-limit"
            inputMode="numeric"
            value={limitValue}
            disabled={!isOwner || busy}
            onChange={(e) => setLimit(e.target.value.trim())}
            className="tabular w-28 font-mono"
          />
          {isOwner && limit !== null && (
            <Button variant="secondary" size="sm" disabled={!limitOk || busy} onClick={() => void save({ ask_daily_per_person: limitNumber })}>
              {t('ask.settings.save')}
            </Button>
          )}
        </div>
        <p className="text-[12.5px] text-muted">{t('ask.settings.limitHint')}</p>
        {s && (
          <p className="text-[13px] text-muted">
            {t('ask.settings.cost', { cost: usd(s.month_cost_usd), cap: usd(s.cap_usd) })}
          </p>
        )}
        <p className="text-[12.5px] text-muted">{t('ask.settings.providers')}</p>
      </Card>

      <Card>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-teal" aria-hidden />
          {t('ask.settings.how')}
        </CardTitle>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] text-muted">
          <li>{t('ask.settings.how1')}</li>
          <li>{t('ask.settings.how2')}</li>
          <li>{t('ask.settings.how3')}</li>
          <li>{t('ask.settings.how4')}</li>
        </ul>
        {isOwner && <p className="mt-3 text-[12.5px] text-faint">{t('ask.settings.kill')}</p>}
      </Card>

      {isOwner && (
        <Card>
          <CardTitle className="flex items-center gap-2">
            <Gem className="h-5 w-5 text-violet" aria-hidden />
            {t('ask.valuables.title')}
          </CardTitle>
          <p className="text-[13.5px] text-muted">{t('ask.valuables.intro')}</p>
          {valuables.data && valuables.data.length === 0 && <p className="mt-3 text-[14px] text-muted">{t('ask.valuables.none')}</p>}
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {(valuables.data ?? []).map((v) => (
              <li key={`${v.kind}-${v.id}`}>
                {v.kind === 'asset' ? (
                  <Link to="/things/$assetId" params={{ assetId: v.id }} className="flex items-center gap-3 py-2.5 hover:bg-white/[0.03]">
                    <Package className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">{v.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {t('ask.valuables.thing')}
                        {v.path ? ` · ${v.path}` : ''}
                      </span>
                    </span>
                  </Link>
                ) : (
                  <Link to="/places/$placeId" params={{ placeId: v.id }} className="flex items-center gap-3 py-2.5 hover:bg-white/[0.03]">
                    <MapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">{v.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {t('ask.valuables.place')} · {v.path}
                      </span>
                    </span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
