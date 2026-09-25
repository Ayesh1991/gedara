import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Figure, LineChart } from '@/components/insights/charts';
import { Num } from '@/components/insights/Num';
import { spendFilter } from '@/lib/insights/drill';
import { spendLinesQuery, utilityQuery } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';
import { categoriesQuery } from '@/lib/money/queries';
import { formatDay, formatMonth } from '@/lib/time';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, lkr } from './common';

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Utilities: units and Rs per unit from recurring bills; how long an LP gas cylinder lasts. */
export function UtilitiesArea({ period, membership, today }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const usage = useQuery(utilityQuery(householdId));
  const categories = useQuery(categoriesQuery(householdId));
  const gasId = categories.data?.find((c) => c.parent_id !== null && c.name.toLowerCase() === 'lp gas')?.id;
  const gas = useQuery({ ...spendLinesQuery(householdId, gasId ? { ...spendFilter({}, period), sub: gasId } : {}, 100), enabled: !!gasId });

  if (usage.isError) return <LoadError />;
  if (!usage.data) return <Loading />;
  const rows = usage.data.filter((u) => u.occurred_on.slice(0, 7) >= period.from && u.occurred_on.slice(0, 7) <= period.to);
  const rules = [...new Map(rows.map((r) => [r.recurring_id, r])).values()];
  const txTo = (id: string) => ({ to: '/money/tx/$txId', params: { txId: id } });

  const gasDates = [...new Set((gas.data ?? []).map((l) => l.occurred_on))].sort();
  const gaps = gasDates.slice(1).map((d, i) => dayDiff(d, gasDates[i]!));
  const avgGap = gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null;

  return (
    <div className="flex flex-col gap-4">
      {rules.length === 0 && (
        <Section title={t('insights.utilities.title')}>
          <Empty>{t('insights.utilities.empty')}</Empty>
          <Link to="/money/recurring" className="text-[13.5px] text-accent-b hover:underline">
            {t('insights.utilities.setUp')}
          </Link>
        </Section>
      )}
      {rules.map((rule) => {
        const pays = rows.filter((r) => r.recurring_id === rule.recurring_id);
        const withUnits = pays.filter((p) => p.units !== null && p.units > 0);
        const last = pays.at(-1)!;
        const lastUnit = withUnits.at(-1);
        return (
          <Section key={rule.recurring_id} title={rule.rule_name}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Figure label={t('insights.utilities.last', { date: formatDay(last.occurred_on, locale, today.slice(0, 4)) })}>
                <Num value={last.amount} whole to={txTo(last.transaction_id)} />
              </Figure>
              {lastUnit && rule.usage_unit && (
                <>
                  <Figure label={t('insights.utilities.units', { unit: rule.usage_unit })}>
                    <Num value={lastUnit.units!} format={(v) => `${v.toLocaleString(locale)} ${rule.usage_unit}`} to={txTo(lastUnit.transaction_id)} />
                  </Figure>
                  <Figure label={t('insights.utilities.perUnit', { unit: rule.usage_unit })} hint={t('insights.utilities.perUnitHint')}>
                    <Num value={lastUnit.per_unit ?? 0} format={(v) => formatLKR(v)} to={txTo(lastUnit.transaction_id)} />
                  </Figure>
                </>
              )}
            </div>
            {pays.length > 1 && (
              <LineChart
                label={withUnits.length > 1 ? t('insights.utilities.units', { unit: rule.usage_unit ?? '' }) : rule.rule_name}
                format={withUnits.length > 1 ? (v) => `${v.toLocaleString(locale)} ${rule.usage_unit}` : lkr}
                points={(withUnits.length > 1 ? withUnits : pays).map((p) => ({
                  key: p.transaction_id,
                  label: formatMonth((p.period ?? p.occurred_on).slice(0, 7), locale, true),
                  value: withUnits.length > 1 ? (p.units ?? 0) : p.amount,
                  to: txTo(p.transaction_id),
                }))}
              />
            )}
            {rule.usage_unit && withUnits.length === 0 && <Empty>{t('insights.utilities.noUnits', { unit: rule.usage_unit })}</Empty>}
          </Section>
        );
      })}
      {gasId && (
        <Section title={t('insights.utilities.gas')}>
          {gasDates.length < 2 ? (
            <Empty>{t('insights.utilities.gasEmpty')}</Empty>
          ) : (
            <>
              <Figure label={t('insights.utilities.gasEvery')}>
                <Num
                  value={avgGap ?? 0}
                  format={(v) => t('insights.pantry.days', { count: v })}
                  to={{ to: '/insights/$area', params: { area: 'spend' }, search: { sub: gasId, from: period.from, to: period.to } }}
                />
              </Figure>
              <ul className="-mx-2 flex flex-col">
                {(gas.data ?? []).map((l) => (
                  <li key={l.line_id}>
                    <Link
                      to="/money/tx/$txId"
                      params={{ txId: l.transaction_id }}
                      search={{ line: l.line_id }}
                      className="flex gap-3 rounded-xl px-2 py-2 text-[14px] hover:bg-white/[0.04]"
                    >
                      <span className="tabular w-28 shrink-0 text-muted">{formatDay(l.occurred_on, locale, today.slice(0, 4))}</span>
                      <span className="min-w-0 flex-1 truncate">{l.merchant_name ?? l.raw_name}</span>
                      <span className="tabular">{lkr(l.amount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}
    </div>
  );
}
