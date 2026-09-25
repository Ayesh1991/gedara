import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarList, Figure, LineChart } from '@/components/insights/charts';
import { Num } from '@/components/insights/Num';
import { Crumbs } from '@/components/insights/PeriodBar';
import { personalInflation } from '@/lib/insights/inflation';
import { priceMonthQuery } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';
import { formatMonth } from '@/lib/time';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, areaTo, lkr, pct } from './common';

/** Price intelligence: Rs per unit over time, shop comparison, and our own inflation index. */
export function PricesArea({ search, period, membership }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const prices = useQuery(priceMonthQuery(householdId));
  if (prices.isError) return <LoadError />;
  if (!prices.data) return <Loading />;

  const inPeriod = prices.data.filter((r) => r.month >= period.from && r.month <= period.to);
  const product = search.product ? inPeriod.filter((r) => r.product_id === search.product) : [];
  const productName = product[0]?.product_name ?? prices.data.find((r) => r.product_id === search.product)?.product_name;
  const unit = product[0]?.unit_code ?? '';
  const perUnit = (v: number) => `${formatLKR(v)}/${unit}`;

  if (search.product) {
    const months = [...new Set(product.map((r) => r.month))].sort();
    const monthly = months.map((m) => {
      const rs = product.filter((r) => r.month === m);
      const qty = rs.reduce((s, r) => s + r.qty, 0);
      return { m, v: rs.reduce((s, r) => s + r.spent, 0) / qty };
    });
    const shops = new Map<string, { name: string; qty: number; spent: number; id: string | null }>();
    for (const r of product) {
      const k = r.merchant_id ?? 'none';
      const s = shops.get(k) ?? { name: r.merchant_name ?? t('insights.noShop'), qty: 0, spent: 0, id: r.merchant_id };
      s.qty += r.qty;
      s.spent += r.spent;
      shops.set(k, s);
    }
    const byShop = [...shops.entries()].map(([k, s]) => ({ k, ...s, avg: s.spent / s.qty })).sort((a, b) => a.avg - b.avg);
    const dearest = byShop.at(-1)?.avg ?? 0;
    return (
      <div className="flex flex-col gap-4">
        <Crumbs area="prices" search={search} labels={{ product: productName }} period={period} locale={locale} />
        {product.length === 0 ? (
          <Section title={productName ?? t('insights.prices.title')}>
            <Empty>{t('insights.prices.noneInPeriod')}</Empty>
          </Section>
        ) : (
          <>
            <Section title={t('insights.prices.overTime', { unit })}>
              {monthly.length > 1 ? (
                <LineChart
                  label={t('insights.prices.overTime', { unit })}
                  format={perUnit}
                  points={monthly.map((x) => ({
                    key: x.m,
                    label: formatMonth(x.m, locale, true),
                    value: x.v,
                    to: areaTo('spend', { product: search.product, from: x.m, to: x.m }),
                  }))}
                />
              ) : (
                <Empty>{t('insights.prices.oneMonth')}</Empty>
              )}
            </Section>
            <Section title={t('insights.prices.byShop')}>
              <BarList
                label={t('insights.prices.byShop')}
                format={perUnit}
                rows={byShop.map((s) => ({
                  key: s.k,
                  label: s.name,
                  sub: dearest > 0 && s.avg < dearest ? t('insights.prices.cheaper', { pct: Math.round((1 - s.avg / dearest) * 100) }) : undefined,
                  value: s.avg,
                  to: areaTo('spend', { product: search.product, merchant: s.k, from: search.from, to: search.to }),
                }))}
              />
            </Section>
          </>
        )}
      </div>
    );
  }

  const inflation = personalInflation(
    inPeriod.map((r) => ({ product_id: r.product_id, product_name: r.product_name, month: r.month, qty: r.qty, spent: r.spent })),
  );
  const byProduct = new Map<string, { name: string; spent: number }>();
  for (const r of inPeriod) {
    const p = byProduct.get(r.product_id) ?? { name: r.product_name, spent: 0 };
    p.spent += r.spent;
    byProduct.set(r.product_id, p);
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('insights.prices.inflation')}>
        {inflation.points.length < 2 || inflation.change === null ? (
          <Empty>{t('insights.prices.inflationEmpty')}</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Figure
                label={t('insights.prices.change', {
                  from: formatMonth(inflation.points[0]!.month, locale, true),
                  to: formatMonth(inflation.points.at(-1)!.month, locale, true),
                })}
                hint={t('insights.prices.basketHint')}
              >
                <Num value={inflation.change} format={pct} to={areaTo('prices', { from: search.from, to: search.to })} />
              </Figure>
            </div>
            <LineChart
              label={t('insights.prices.inflation')}
              baseline={100}
              format={(v) => v.toFixed(1)}
              points={inflation.points.map((p) => ({
                key: p.month,
                label: formatMonth(p.month, locale, true),
                value: p.index,
                to: areaTo('prices', { from: p.month, to: p.month }),
              }))}
            />
          </>
        )}
      </Section>
      {inflation.movers.length > 0 && (
        <Section title={t('insights.prices.movers')}>
          <BarList
            label={t('insights.prices.movers')}
            format={pct}
            rows={inflation.movers.map((m) => ({
              key: m.product_id,
              label: m.name,
              sub: `${formatLKR(m.first)} → ${formatLKR(m.last)}`,
              value: m.change,
              valueText: pct(m.change),
              tone: m.change > 0.1 ? 'caution' : 'default',
              to: areaTo('prices', { product: m.product_id, from: search.from, to: search.to }),
            }))}
          />
        </Section>
      )}
      <Section title={t('insights.prices.products')}>
        {byProduct.size === 0 ? (
          <Empty>{t('insights.prices.empty')}</Empty>
        ) : (
          <BarList
            label={t('insights.prices.products')}
            format={lkr}
            rows={[...byProduct.entries()]
              .sort((a, b) => b[1].spent - a[1].spent)
              .map(([id, p]) => ({ key: id, label: p.name, value: p.spent, to: areaTo('prices', { ...search, product: id }) }))}
          />
        )}
      </Section>
    </div>
  );
}
