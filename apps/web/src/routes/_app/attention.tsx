import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { BellRing, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AttentionRow } from '@/components/attention/AttentionRow';
import { Card } from '@/components/ui/card';
import { groupBySeverity, knownItems } from '@/lib/attention';
import { attentionQuery } from '@/lib/insights/queries';
import { todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/attention')({
  component: AttentionPage,
});

/** Everything that needs a look (MASTER_PLAN §4 row 7) — the same list the 07:00 notification summarises. */
function AttentionPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone } = membership.household;
  const today = todayIn(timezone);
  const feed = useQuery({ ...attentionQuery(householdId), refetchOnWindowFocus: true });
  const items = knownItems(feed.data ?? []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('attention.title')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('attention.intro')}</p>
        </div>
        <Link to="/settings/notifications" className="inline-flex items-center gap-2 text-[13.5px] text-accent-b hover:underline">
          <BellRing className="h-4 w-4" aria-hidden />
          {t('attention.notifications')}
        </Link>
      </div>
      {feed.isError ? (
        <Card className="text-[14px] text-red">{t('attention.error')}</Card>
      ) : !feed.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : items.length === 0 ? (
        <Card className="flex items-center gap-3">
          <CircleCheck className="h-6 w-6 shrink-0 text-teal" aria-hidden />
          <p className="text-[14.5px] text-[#a5b0d0]">{t('home.attentionEmpty')}</p>
        </Card>
      ) : (
        groupBySeverity(items).map(([severity, group]) => (
          <section key={severity} aria-label={t(`attention.severity.${severity}`)} className="flex flex-col gap-2">
            <h2 className="px-1 text-[12.5px] font-medium tracking-wide text-muted uppercase">
              {t(`attention.severity.${severity}`)} · {group.length}
            </h2>
            <ul className="flex flex-col gap-2">
              {group.map((i) => (
                <AttentionRow key={i.item_key} item={i} householdId={householdId} canWrite={membership.role !== 'viewer'} today={today} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
