import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Link2, Pencil, Plus, Repeat, SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState } from '@/components/aurora/EmptyState';
import { LinkSheet, PaySheet, RuleSheet } from '@/components/money/RecurringSheets';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { invalidateInsights } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';
import { invalidateMoney } from '@/lib/money/queries';
import { PRESETS } from '@/lib/recurring/match';
import { recurringErrorKey, rulesQuery, skipPeriod, unskip, type RecurringRule } from '@/lib/recurring/queries';
import { textParam } from '@/lib/search';
import { formatDay, todayIn } from '@/lib/time';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';

const id = () => textParam(36).pipe(z.string().uuid());
const SearchSchema = z.object({
  pay: id().optional(),
  link: id().optional(),
  edit: id().optional(),
  /** '1' = empty form, else a preset key (ceb, water, telecom, gas, insurance). */
  add: textParam(20).optional(),
});

export const Route = createFileRoute('/_app/money/recurring')({
  validateSearch: SearchSchema,
  component: RecurringPage,
});

/** Recurring bills (§3.6): CEB, water, phone, gas, insurance, salary — due dates feed Attention. */
function RecurringPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/money/recurring' });
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const rules = useQuery(rulesQuery(householdId));
  const { accounts, categories } = useMoneyBasics(householdId);
  const find = (rid?: string) => (rid ? (rules.data?.find((r) => r.id === rid) ?? null) : null);
  const close = () => void navigate({ search: {}, replace: true });
  const open = (patch: z.infer<typeof SearchSchema>) => void navigate({ search: patch });

  const active = (rules.data ?? []).filter((r) => r.active);
  const paused = (rules.data ?? []).filter((r) => !r.active);

  async function skip(r: RecurringRule) {
    try {
      const skipId = await skipPeriod(householdId, r.id, r.next_due);
      await Promise.all([invalidateMoney(qc, householdId), invalidateInsights(qc, householdId)]);
      toast(t('recurring.skipped', { name: r.name, date: formatDay(r.next_due, locale) }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            unskip(skipId)
              .then(() => Promise.all([invalidateMoney(qc, householdId), invalidateInsights(qc, householdId)]))
              .catch((e: unknown) => toast.error(t(`recurring.errors.${recurringErrorKey(e)}`)));
          },
        },
      });
    } catch (e) {
      toast.error(t(`recurring.errors.${recurringErrorKey(e)}`));
    }
  }

  const dueText = (r: RecurringRule) =>
    r.days_left < 0
      ? t('recurring.overdue', { count: -r.days_left })
      : r.days_left === 0
        ? t('recurring.dueToday')
        : t('recurring.dueIn', { count: r.days_left });

  const card = (r: RecurringRule) => {
    const soon = r.days_left <= r.notify_days_before;
    return (
      <li key={r.id}>
        <Card className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[17px] font-semibold">{r.name}</div>
              <div className="truncate text-[12.5px] text-muted">
                {[r.category_name, t(`recurring.every.${r.every_unit}`, { count: r.every_n }), r.usage_unit, r.asset_name].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="text-right">
              <div className={cn('tabular text-[14px] font-medium', r.days_left < 0 ? 'text-red' : soon ? 'text-due' : 'text-text')}>{dueText(r)}</div>
              <div className="tabular text-[12.5px] text-muted">{formatDay(r.next_due, locale, today.slice(0, 4))}</div>
            </div>
          </div>
          <div className="tabular flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
            {(r.expected_amount ?? r.last_amount) !== null && <span>{t('recurring.usual', { amount: formatLKR((r.expected_amount ?? r.last_amount)!, { whole: true }) })}</span>}
            {r.last_transaction_id && r.last_paid_on && (
              <Link to="/money/tx/$txId" params={{ txId: r.last_transaction_id }} className="text-accent-b hover:underline">
                {t('recurring.lastPaid', { date: formatDay(r.last_paid_on, locale, today.slice(0, 4)), amount: formatLKR(r.last_amount ?? 0, { whole: true }) })}
              </Link>
            )}
          </div>
          {canWrite && r.active && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={soon ? 'accent' : 'secondary'} onClick={() => open({ pay: r.id })}>
                <Repeat className="h-4 w-4" aria-hidden />
                {t('recurring.pay')}
              </Button>
              <Button size="sm" onClick={() => open({ link: r.id })}>
                <Link2 className="h-4 w-4" aria-hidden />
                {t('recurring.link')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void skip(r)}>
                <SkipForward className="h-4 w-4" aria-hidden />
                {t('recurring.skip')}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('recurring.editTitle')} onClick={() => open({ edit: r.id })}>
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          )}
          {canWrite && !r.active && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => open({ edit: r.id })}>
              <Pencil className="h-4 w-4" aria-hidden />
              {t('recurring.editTitle')}
            </Button>
          )}
        </Card>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Link to="/money" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('nav.money')}
          </Link>
          <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('recurring.title')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('recurring.intro')}</p>
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => open({ add: '1' })}>
            <Plus className="h-5 w-5" aria-hidden />
            {t('recurring.add')}
          </Button>
        )}
      </div>

      {canWrite && (
        <div className="flex flex-wrap gap-2" aria-label={t('recurring.presets')}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => open({ add: p.key })}
              className="rounded-full border border-line-2 px-3.5 py-1.5 text-[13px] text-muted hover:text-text"
            >
              + {t(`recurring.preset.${p.key as 'ceb'}`)}
            </button>
          ))}
        </div>
      )}

      {rules.isError ? (
        <Card className="text-[14px] text-red">{t('recurring.errors.generic')}</Card>
      ) : !rules.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : rules.data.length === 0 ? (
        <EmptyState icon={Repeat} title={t('recurring.emptyTitle')} body={t('recurring.emptyBody')} />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">{active.map(card)}</ul>
          {paused.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-[12.5px] font-medium text-muted uppercase">{t('recurring.paused')}</h2>
              <ul className="grid grid-cols-1 gap-3 opacity-70 lg:grid-cols-2">{paused.map(card)}</ul>
            </section>
          )}
        </>
      )}

      <PaySheet
        rule={find(search.pay)}
        householdId={householdId}
        accounts={accounts.data ?? []}
        categories={categories.data ?? []}
        today={today}
        locale={locale}
        onClose={close}
      />
      <LinkSheet rule={find(search.link)} householdId={householdId} today={today} locale={locale} onClose={close} />
      <RuleSheet
        open={!!search.add || !!find(search.edit)}
        rule={find(search.edit)}
        householdId={householdId}
        accounts={accounts.data ?? []}
        categories={categories.data ?? []}
        today={today}
        preset={search.add && search.add !== '1' ? search.add : undefined}
        onClose={close}
      />
    </div>
  );
}
