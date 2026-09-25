import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { BellOff, BellRing, ChevronLeft, Send, Share, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { myDevicesQuery } from '@/lib/insights/queries';
import { currentSubscription, disablePush, enablePush, isIos, pushSupport, sendTestPush } from '@/lib/push/client';
import { supabase } from '@/lib/supabase';

export const Route = createFileRoute('/_app/settings/notifications')({
  component: NotificationsPage,
});

/**
 * One summary each morning at 07:00 of what needs attention, on the devices you turn it on for
 * (MASTER_PLAN §4 row 7). iPhone / iPad: only from the Home-Screen app (§11.3); the in-app feed
 * works everywhere without it.
 */
function NotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const support = pushSupport();
  const devices = useQuery(myDevicesQuery(householdId));
  const here = useQuery({ queryKey: ['push-here'], queryFn: async () => (await currentSubscription())?.endpoint ?? null, staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['push-devices', householdId] }), qc.invalidateQueries({ queryKey: ['push-here'] })]);
  const onHere = !!here.data && (devices.data ?? []).some((d) => d.endpoint === here.data);
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  async function turnOn() {
    setBusy(true);
    try {
      const r = await enablePush(householdId);
      if (r === 'denied') toast.error(t('notifications.denied'));
      else if (r === 'not-configured') toast.error(t('notifications.notConfigured'));
      else toast.success(t('notifications.on'));
    } catch {
      toast.error(t('notifications.error'));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await disablePush();
      toast(t('notifications.off'));
    } catch {
      toast.error(t('notifications.error'));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function test(id?: string) {
    setBusy(true);
    try {
      const r = await sendTestPush(id);
      if (r.sent > 0) toast.success(t('notifications.testSent', { count: r.sent }));
      else toast.error(t('notifications.testFailed'));
    } catch {
      toast.error(t('notifications.error'));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function remove(id: string) {
    const { error } = await supabase.from('push_subscription').delete().eq('id', id);
    if (error) toast.error(t('notifications.error'));
    await refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/settings" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('settings.title')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('notifications.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('notifications.intro')}</p>
      </div>

      <Card className="flex flex-col gap-4">
        <h2 className="font-display text-[17px] font-semibold">{t('notifications.thisDevice')}</h2>
        {support === 'needs-install' ? (
          <div className="flex flex-col gap-2 text-[14.5px] text-[#a5b0d0]">
            <p>{t('notifications.iosInstall')}</p>
            <p className="flex items-center gap-2">
              <Share className="h-4 w-4 shrink-0" aria-hidden />
              {t('notifications.iosSteps')}
            </p>
          </div>
        ) : support === 'unsupported' ? (
          <p className="text-[14.5px] text-[#a5b0d0]">{t(isIos() ? 'notifications.iosOld' : 'notifications.unsupported')}</p>
        ) : blocked ? (
          <p className="text-[14.5px] text-caution">{t('notifications.blocked')}</p>
        ) : onHere ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" disabled={busy} onClick={() => void test(devices.data?.find((d) => d.endpoint === here.data)?.id)}>
              <Send className="h-4 w-4" aria-hidden />
              {t('notifications.test')}
            </Button>
            <Button disabled={busy} onClick={() => void turnOff()}>
              <BellOff className="h-4 w-4" aria-hidden />
              {t('notifications.turnOff')}
            </Button>
          </div>
        ) : (
          <Button variant="primary" className="self-start" disabled={busy} onClick={() => void turnOn()}>
            <BellRing className="h-4 w-4" aria-hidden />
            {t('notifications.turnOn')}
          </Button>
        )}
        <p className="text-[12.5px] text-faint">{t('notifications.privacy')}</p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-[17px] font-semibold">{t('notifications.myDevices')}</h2>
        {!devices.data ? (
          <div className="glass h-16 animate-pulse rounded-2xl" aria-hidden />
        ) : devices.data.length === 0 ? (
          <p className="text-[14px] text-muted">{t('notifications.noDevices')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {devices.data.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2.5">
                <Smartphone className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px]">
                    {d.label ?? t('notifications.device')}
                    {d.endpoint === here.data && <span className="ml-2 text-[12px] text-accent-b">{t('notifications.thisOne')}</span>}
                  </div>
                  <div className="truncate text-[12px] text-muted">
                    {d.last_error
                      ? t('notifications.lastError', { error: d.last_error })
                      : d.last_ok_at
                        ? t('notifications.lastOk', { date: new Date(d.last_ok_at).toLocaleString() })
                        : t('notifications.neverSent')}
                  </div>
                </div>
                <Button size="icon" variant="ghost" aria-label={t('notifications.testOne', { name: d.label ?? '' })} disabled={busy} onClick={() => void test(d.id)}>
                  <Send className="h-4 w-4" aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" aria-label={t('notifications.remove', { name: d.label ?? '' })} onClick={() => void remove(d.id)}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
