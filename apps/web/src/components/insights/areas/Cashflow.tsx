import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BarList, Columns, Figure, LineChart } from '@/components/insights/charts';
import { Num } from '@/components/insights/Num';
import { monthsOf, spendFilter } from '@/lib/insights/drill';
import { budgetMonthQuery, monthEndQuery, spendGroupsQuery } from '@/lib/insights/queries';
import { accountsQuery, cashflowQuery } from '@/lib/money/queries';
import { formatMonth } from '@/lib/time';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, areaTo, lkr } from './common';

/** Cash flow: in vs out, savings rate, budget vs actual, recurring vs the rest, balances over time. */
export function CashflowArea({ search, period, membership }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const flow = useQuery(cashflowQuery(householdId));
  const budgets = useQuery(budgetMonthQuery(householdId, period.to));
  const recurring = useQuery(spendGroupsQuery(householdId, spendFilter({}, period), 'recurring'));
  const monthEnd = useQuery(monthEndQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId));

  if (flow.isError) return <LoadError />;
  if (!flow.data) return <Loading />;

  const months = monthsOf(period);
  const rows = months.map((m) => flow.data.find((f) => f.month === m) ?? { month: m, income: 0, spent: 0, net: 0, bills: 0 });
  const income = rows.reduce((s, r) => s + r.income, 0);
  const spent = rows.reduce((s, r) => s + r.spent, 0);
  const net = income - spent;
  const has = rows.some((r) => r.income > 0 || r.spent > 0);
  const moneyMonth = { to: '/money', search: { month: period.to } };

  const suspense = new Set((accounts.data ?? []).filter((a) => a.is_suspense || a.archived).map((a) => a.id));
  const ends = (monthEnd.data ?? []).filter((r) => !suspense.has(r.account_id) && r.month >= period.from && r.month <= period.to);
  const totalByMonth = months
    .map((m) => ({ m, rows: ends.filter((r) => r.month === m) }))
    .filter((x) => x.rows.length > 0)
    .map((x) => ({ m: x.m, v: x.rows.reduce((s, r) => s + r.balance, 0) }));
  const latest = months.at(-1)!;
  const latestByAccount = ends.filter((r) => r.month === latest).sort((a, b) => b.balance - a.balance);

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('insights.cashflow.inOut')}>
        {!has ? (
          <Empty>{t('insights.cashflow.empty')}</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label={t('home.income')}>
                <Num value={income} whole to={moneyMonth} />
              </Figure>
              <Figure label={t('home.outgoing')}>
                <Num value={spent} whole to={areaTo('spend', { from: period.from, to: period.to })} />
              </Figure>
              <Figure label={t('insights.cashflow.net')}>
                <Num value={net} whole signed to={moneyMonth} />
              </Figure>
              <Figure label={t('insights.cashflow.savingsRate')} hint={t('insights.cashflow.savingsHint')}>
                {income > 0 ? (
                  <Num value={net / income} format={(v) => `${Math.round(v * 100)} %`} to={moneyMonth} />
                ) : (
                  '—'
                )}
              </Figure>
            </div>
            {months.length > 1 && (
              <Columns
                label={t('insights.cashflow.inOut')}
                series={[
                  { label: t('home.income'), color: 'var(--accent-b)' },
                  { label: t('home.outgoing'), color: 'var(--accent-a)' },
                ]}
                format={lkr}
                groups={rows.map((r) => ({
                  key: r.month,
                  label: formatMonth(r.month, locale, true),
                  values: [r.income, r.spent],
                  to: { to: '/money', search: { month: r.month } },
                }))}
              />
            )}
          </>
        )}
      </Section>

      <Section
        title={t('insights.cashflow.budget', { month: formatMonth(period.to, locale) })}
        action={
          <Link to="/money/budgets" search={{ month: period.to }} className="text-[13px] text-accent-b hover:underline">
            {t('insights.cashflow.editBudgets')}
          </Link>
        }
      >
        {!budgets.data ? (
          <Loading />
        ) : budgets.data.every((b) => b.budget === null) ? (
          <Empty>{t('home.budgetEmpty')}</Empty>
        ) : (
          <BarList
            label={t('insights.cashflow.budget', { month: formatMonth(period.to, locale) })}
            format={lkr}
            rows={budgets.data.map((b) => ({
              key: b.category_id,
              label: b.name,
              sub: b.budget !== null ? t('insights.cashflow.ofBudget', { budget: lkr(b.budget) }) : t('insights.cashflow.noBudget'),
              value: b.spent,
              ghost: b.budget ?? undefined,
              tone: b.budget !== null && b.spent > b.budget ? 'red' : b.budget !== null && b.spent >= b.budget * 0.9 ? 'caution' : 'default',
              to: areaTo('spend', { cat: b.category_id, from: period.to, to: period.to }),
            }))}
          />
        )}
      </Section>

      <Section title={t('insights.cashflow.recurring')}>
        {!recurring.data ? (
          <Loading />
        ) : recurring.data.length === 0 ? (
          <Empty>{t('insights.spend.empty')}</Empty>
        ) : (
          <BarList
            label={t('insights.cashflow.recurring')}
            format={lkr}
            rows={recurring.data.map((g) => ({
              key: g.key,
              label: t(`insights.recurringFilter.${g.key === 'true' ? 'yes' : 'no'}`),
              sub: t('insights.spend.linesCount', { count: g.lines }),
              value: g.amount,
              to: areaTo('spend', { from: search.from, to: search.to, recurring: g.key === 'true' ? 'yes' : 'no' }),
            }))}
          />
        )}
      </Section>

      <Section title={t('insights.cashflow.balances')}>
        {!monthEnd.data ? (
          <Loading />
        ) : totalByMonth.length === 0 ? (
          <Empty>{t('insights.cashflow.balancesEmpty')}</Empty>
        ) : (
          <>
            {totalByMonth.length > 1 && (
              <LineChart
                label={t('insights.cashflow.balances')}
                format={lkr}
                points={totalByMonth.map((x) => ({
                  key: x.m,
                  label: formatMonth(x.m, locale, true),
                  value: x.v,
                  to: { to: '/money', search: { month: x.m } },
                }))}
              />
            )}
            <BarList
              label={t('insights.cashflow.balances')}
              format={lkr}
              rows={latestByAccount.map((r) => ({
                key: r.account_id,
                label: r.account_name,
                sub: t(`money.kinds.${r.kind as 'cash'}`),
                value: r.balance,
                valueText: `${r.balance < 0 ? '−' : ''}${lkr(Math.abs(r.balance))}`,
                to: { to: '/money/accounts/$accountId', params: { accountId: r.account_id } },
              }))}
            />
          </>
        )}
      </Section>
    </div>
  );
}
