import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { CalendarClock, ChevronLeft, Landmark, MessageSquareText, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/aurora/EmptyState';
import { PlanSheet, type PlanDraft } from '@/components/money/PlanSheet';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { planAlertsQuery, plansQuery, type Plan } from '@/lib/money/instalmentQueries';
import { dueInMonth, endings, planFromAlert, planStatus } from '@/lib/money/instalments';
import { formatLKR } from '@/lib/money/format';
import { formatDay, todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/money/instalments')({
  component: InstalmentsPage,
});

const monthName = (ym: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));

/**
 * Money › Instalments (Phase 9b.2): every card instalment plan and loan at a glance — this month's
 * total, where each plan stands, what is left, when the monthly total drops. Reference only: the bank's
 * entries and Gedara's transfers move the money.
 */
function InstalmentsPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const year = today.slice(0, 4);
  const plans = useQuery(plansQuery(householdId));
  const alerts = useQuery(planAlertsQuery(householdId));
  const { accounts } = useMoneyBasics(householdId);
  const [sheet, setSheetState] = useState<{ plan: Plan | null; draft: PlanDraft | null; key: number } | null>(null);
  const setSheet = (s: { plan: Plan | null; draft: PlanDraft | null } | null) => setSheetState(s && { ...s, key: Date.now() });
  const accountName = (id: string | null) => accounts.data?.find((a) => a.id === id)?.name ?? '—';

  const rows = (plans.data ?? []).filter((p) => !p.archived).map((p) => ({ p, s: planStatus(p, today) }));
  const active = rows.filter((r) => !r.s.done);
  const finished = rows.filter((r) => r.s.done);
  const month = today.slice(0, 7);
  const thisMonth = active.filter((r) => dueInMonth(r.p, month)).reduce((s, r) => s + r.p.monthly, 0);
  const cardsLeft = active.filter((r) => r.p.kind === 'card').reduce((s, r) => s + r.s.leftToPay, 0);
  const loansOwed = active.reduce((s, r) => s + (r.s.loan?.owed ?? 0), 0);
  const drops = endings(active.map((r) => r.p), today);
  const linkedAlerts = new Set((plans.data ?? []).map((p) => p.source_sms_id).filter(Boolean));
  const offers = (alerts.data ?? []).filter((a) => !linkedAlerts.has(a.id)).map((a) => ({ a, parsed: planFromAlert(a.body) })).filter((x) => x.parsed);

  // the monthly total after each drop (soonest first)
  const after = drops.map((_, i) => Math.max(0, thisMonth - drops.slice(0, i + 1).reduce((s, e) => s + e.drop, 0)));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Link to="/money" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('nav.money')}
          </Link>
          <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('instalments.title')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('instalments.intro')}</p>
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => setSheet({ plan: null, draft: null })}>
            <Plus className="h-5 w-5" aria-hidden />
            {t('instalments.add')}
          </Button>
        )}
      </div>

      {plans.isError ? (
        <Card className="text-[14px] text-red">{t('instalments.loadFailed')}</Card>
      ) : !plans.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : rows.length === 0 && offers.length === 0 ? (
        <EmptyState icon={CalendarClock} title={t('instalments.emptyTitle')} body={t('instalments.emptyBody')} />
      ) : (
        <>
          {active.length > 0 && (
            <Card className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-[12.5px] text-muted">{t('instalments.thisMonth', { month: monthName(month, locale) })}</div>
                <div className="tabular font-display text-[24px] font-semibold">{formatLKR(thisMonth)}</div>
                <div className="text-[12.5px] text-muted">{t('instalments.plansCount', { count: active.length })}</div>
              </div>
              <div>
                <div className="text-[12.5px] text-muted">{t('instalments.cardsLeft')}</div>
                <div className="tabular font-display text-[20px] font-semibold">{formatLKR(cardsLeft)}</div>
              </div>
              {loansOwed > 0 && (
                <div>
                  <div className="text-[12.5px] text-muted">{t('instalments.loansOwed')}</div>
                  <div className="tabular font-display text-[20px] font-semibold">{formatLKR(loansOwed)}</div>
                </div>
              )}
            </Card>
          )}

          {offers.length > 0 && canWrite && (
            <section className="flex flex-col gap-2" aria-labelledby="plan-offers">
              <h2 id="plan-offers" className="px-1 text-[12.5px] font-medium text-muted uppercase">{t('instalments.offersTitle')}</h2>
              <ul className="flex flex-col gap-2">
                {offers.map(({ a, parsed }) => (
                  <li key={a.id} className="glass flex flex-wrap items-center gap-3 rounded-[var(--r)] px-3.5 py-3">
                    <MessageSquareText className="h-4 w-4 shrink-0 text-info" aria-hidden />
                    <span className="min-w-0 flex-1 text-[13.5px]">
                      {t('instalments.offer', { name: a.merchant_text ?? '?', months: parsed!.months, amount: formatLKR(parsed!.total), day: formatDay(a.occurred_on, locale, year) })}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setSheet({
                        plan: null,
                        draft: {
                          kind: 'card', account_id: a.account_id, name: a.merchant_text ?? '',
                          monthly: String(Math.round((parsed!.total / parsed!.months) * 100) / 100), total: String(parsed!.months),
                          current: '1', currentOn: a.occurred_on, principal: '', rate: '', source_sms_id: a.id,
                        },
                      })}
                    >
                      {t('instalments.addFromAlert')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {active.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label={t('instalments.title')}>
              {active.map(({ p, s }) => (
                <li key={p.id}>
                  <Card className="flex flex-col gap-2.5">
                    <div className="flex items-start gap-3">
                      {p.kind === 'loan' && <Landmark className="mt-1 h-4 w-4 shrink-0 text-info" aria-hidden />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-[17px] font-semibold">{p.name}</div>
                        <div className="truncate text-[12.5px] text-muted">{accountName(p.account_id)}</div>
                      </div>
                      <div className="text-right">
                        <div className="tabular text-[15px] font-medium">{formatLKR(p.monthly)}</div>
                        <div className="text-[12px] text-muted">{t('instalments.perMonth')}</div>
                      </div>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
                      role="meter"
                      aria-label={t('instalments.progress', { paid: s.paid, total: p.total_count })}
                      aria-valuemin={0}
                      aria-valuemax={p.total_count}
                      aria-valuenow={s.paid}
                    >
                      <div className="h-full rounded-full bg-[var(--info)]" style={{ width: `${(s.paid / p.total_count) * 100}%` }} />
                    </div>
                    <div className="tabular flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
                      <span className="text-text">{t('instalments.progress', { paid: s.paid, total: p.total_count })}</span>
                      {s.nextOn && <span>{t('instalments.next', { day: formatDay(s.nextOn, locale, year) })}</span>}
                      <span>{t('instalments.last', { day: formatDay(s.lastOn, locale, year) })}</span>
                      {p.kind === 'card' && <span>{t('instalments.leftToPay', { amount: formatLKR(s.leftToPay) })}</span>}
                    </div>
                    {s.loan && (
                      <div className="tabular flex flex-col gap-0.5 rounded-2xl bg-white/[0.035] px-3 py-2.5 text-[13px]">
                        <span>{t('instalments.loanOwed', { amount: formatLKR(s.loan.owed) })}</span>
                        <span className="text-muted">
                          {t('instalments.loanNext', { interest: formatLKR(s.loan.nextInterest), principal: formatLKR(s.loan.nextPrincipal) })}
                        </span>
                        <span className="text-muted">{t('instalments.loanInterestLeft', { amount: formatLKR(s.loan.interestLeft) })}</span>
                      </div>
                    )}
                    {canWrite && (
                      <Button size="sm" variant="ghost" className="self-start" onClick={() => setSheet({ plan: p, draft: null })}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t('instalments.editTitle')}
                      </Button>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}

          {drops.length > 0 && (
            <Card className="flex flex-col gap-2">
              <h2 className="font-display text-[18px] font-semibold">{t('instalments.dropsTitle')}</h2>
              <ol className="flex flex-col divide-y divide-line">
                {drops.map((e, i) => (
                  <li key={e.month} className="tabular flex flex-wrap items-baseline gap-x-3 py-2 text-[13.5px]">
                    <span className="w-24 shrink-0 font-medium">{monthName(e.month, locale)}</span>
                    <span className="min-w-0 flex-1 text-muted">{e.plans.map((x) => x.name).join(', ')}</span>
                    <span>{t('instalments.dropBy', { amount: formatLKR(e.drop), now: formatLKR(after[i]!) })}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {finished.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-[12.5px] font-medium text-muted uppercase">{t('instalments.finished')}</h2>
              <ul className="flex flex-col gap-1.5 opacity-70">
                {finished.map(({ p, s }) => (
                  <li key={p.id} className="glass flex items-center gap-3 rounded-[var(--r)] px-3.5 py-2.5 text-[13.5px]">
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="tabular text-muted">{t('instalments.endedOn', { day: formatDay(s.lastOn, locale, year) })}</span>
                    {canWrite && (
                      <Button size="sm" variant="ghost" aria-label={t('instalments.editTitle')} onClick={() => setSheet({ plan: p, draft: null })}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <PlanSheet
        key={sheet?.key ?? 0}
        open={!!sheet}
        plan={sheet?.plan ?? null}
        draft={sheet?.draft ?? null}
        householdId={householdId}
        accounts={accounts.data ?? []}
        today={today}
        onClose={() => setSheet(null)}
      />
    </div>
  );
}
