import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BarList, Columns, Heatmap } from '@/components/insights/charts';
import { Num } from '@/components/insights/Num';
import { Crumbs } from '@/components/insights/PeriodBar';
import { Money } from '@/components/money/bits';
import { SPEND_BY, drillInto, isSingleMonth, monthsOf, spendFilter, spendGroupBy, spendLevel } from '@/lib/insights/drill';
import { spendGroupsQuery, spendLinesQuery } from '@/lib/insights/queries';
import { accountsQuery, categoriesQuery, merchantsQuery } from '@/lib/money/queries';
import { productsQuery } from '@/lib/pantry/queries';
import { formatDay, formatMonth } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, areaTo, lkr } from './common';

export function weekdayNames(locale: string): string[] {
  // 2026-09-21 is a Monday (ISO weekday 1).
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 21 + i))),
  );
}

/** Spend: category → sub-category → product / printed name → the bill lines (MASTER_PLAN §6). */
export function SpendArea({ search, period, membership }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const categories = useQuery(categoriesQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId));
  const merchants = useQuery(merchantsQuery(householdId));
  const products = useQuery(productsQuery(householdId));
  const cats = categories.data ?? [];
  const catHasSubs = !!search.cat && cats.some((c) => c.parent_id === search.cat);
  const level = spendLevel(search, catHasSubs);
  const filter = spendFilter(search, period);
  const by = spendGroupBy(level, search.by);
  const groups = useQuery({ ...spendGroupsQuery(householdId, filter, by), enabled: level !== 'records' });
  const months = useQuery({ ...spendGroupsQuery(householdId, filter, 'month'), enabled: !isSingleMonth(period) });
  const lines = useQuery({ ...spendLinesQuery(householdId, filter), enabled: level === 'records' });
  const days = weekdayNames(locale);

  const catName = (id: string | undefined) => (id === 'none' ? t('insights.uncategorised') : cats.find((c) => c.id === id)?.name);
  const labels: Record<string, string | undefined> = {
    cat: catName(search.cat),
    sub: catName(search.sub),
    product: products.data?.find((p) => p.id === search.product)?.name,
    name: search.name,
    merchant: search.merchant === 'none' ? t('insights.noShop') : merchants.data?.find((m) => m.id === search.merchant)?.name,
    account: accounts.data?.find((a) => a.id === search.account)?.name,
    kind: search.kind ? t(`money.kinds.${search.kind}`) : undefined,
    recurring: search.recurring ? t(`insights.recurringFilter.${search.recurring}`) : undefined,
    weekday: search.weekday ? days[Number(search.weekday) - 1] : undefined,
    hour: search.hour ? (search.hour === 'none' ? t('insights.noTime') : `${search.hour.padStart(2, '0')}:00`) : undefined,
  };

  const groupLabel = (key: string, label: string | null) => {
    if (by === 'kind') return t(`money.kinds.${key as 'cash'}`);
    if (key === 'none') return by === 'merchant' ? t('insights.noShop') : t('insights.uncategorised');
    return label ?? '—';
  };
  const total = (groups.data ?? []).reduce((s, g) => s + g.amount, 0);
  const lineTotal = (lines.data ?? []).reduce((s, l) => s + l.amount, 0);

  return (
    <div className="flex flex-col gap-4">
      <Crumbs area="spend" search={search} labels={labels} period={period} locale={locale} />

      {level === 'domain' && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('insights.spend.byLabel')}>
          {SPEND_BY.map((b) => (
            <Link
              key={b}
              to="/insights/$area"
              params={{ area: 'spend' }}
              search={{ ...search, by: b === 'category' ? undefined : b }}
              className={cn(
                'rounded-full border px-3 py-1 text-[13px]',
                (search.by ?? 'category') === b ? 'accent-pill border-transparent text-text' : 'border-line-2 text-muted hover:text-text',
              )}
            >
              {t(`insights.spend.by.${b}`)}
            </Link>
          ))}
        </div>
      )}

      {!isSingleMonth(period) && (months.data?.length ?? 0) > 0 && (
        <Section title={t('insights.spend.perMonth')}>
          <Columns
            label={t('insights.spend.perMonth')}
            series={[{ label: t('home.outgoing'), color: 'var(--accent-a)' }]}
            format={lkr}
            groups={monthsOf(period).map((m) => ({
              key: m,
              label: formatMonth(m, locale, true),
              values: [months.data?.find((g) => g.key === m)?.amount ?? 0],
              to: areaTo('spend', { ...search, from: m, to: m }),
            }))}
          />
        </Section>
      )}

      {level !== 'records' ? (
        groups.isError ? (
          <LoadError />
        ) : !groups.data ? (
          <Loading />
        ) : groups.data.length === 0 ? (
          <Section title={t('insights.spend.title')}>
            <Empty>{t('insights.spend.empty')}</Empty>
          </Section>
        ) : by === 'weekday_hour' ? (
          <Section title={t('insights.spend.by.time')}>
            <Heatmap
              label={t('insights.spend.by.time')}
              rowLabels={days}
              format={lkr}
              cells={new Map(groups.data.filter((g) => !g.key.endsWith(':none')).map((g) => [g.key, g.amount]))}
              cellTo={(d, h) => areaTo('spend', { ...search, by: undefined, weekday: String(d), hour: String(h) })}
            />
            {groups.data.some((g) => g.key.endsWith(':none')) && (
              <p className="text-[13px] text-muted">
                {t('insights.spend.noTimeTotal')}{' '}
                <Num
                  value={groups.data.filter((g) => g.key.endsWith(':none')).reduce((s, g) => s + g.amount, 0)}
                  whole
                  to={areaTo('spend', { from: search.from, to: search.to, hour: 'none', weekday: undefined })}
                />
              </p>
            )}
          </Section>
        ) : (
          <Section
            title={t(`insights.spend.level.${level}`)}
            action={<Num value={total} whole to={{ to: '/money', search: { month: period.to, cat: search.cat && search.cat !== 'none' ? search.cat : undefined } }} className="text-[15px] font-semibold" />}
          >
            <BarList
              label={t(`insights.spend.level.${level}`)}
              format={lkr}
              rows={groups.data.map((g) => ({
                key: g.key,
                label: groupLabel(g.key, g.label),
                sub: t('insights.spend.linesCount', { count: g.lines }),
                value: g.amount,
                to: areaTo('spend', { ...search, ...drillInto(level, search.by, g.key) }),
              }))}
            />
          </Section>
        )
      ) : lines.isError ? (
        <LoadError />
      ) : !lines.data ? (
        <Loading />
      ) : (
        <Section
          title={t('insights.spend.records', { count: lines.data.length })}
          action={<span className="tabular text-[15px] font-semibold">{lkr(lineTotal)}</span>}
        >
          {lines.data.length === 0 ? (
            <Empty>{t('insights.spend.empty')}</Empty>
          ) : (
            <ul className="-mx-2 divide-y divide-line">
              {lines.data.map((l) => (
                <li key={l.line_id}>
                  <Link
                    to="/money/tx/$txId"
                    params={{ txId: l.transaction_id }}
                    search={{ line: l.line_id }}
                    className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.04]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14.5px]">{l.raw_name}</div>
                      <div className="truncate text-[12.5px] text-muted">
                        {[formatDay(l.occurred_on, locale), l.merchant_name, l.qty != null ? `${l.qty} ${l.unit_text ?? ''}`.trim() : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <Money value={l.amount} className="text-[14.5px]" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
