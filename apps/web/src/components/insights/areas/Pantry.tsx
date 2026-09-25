import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BarList, Figure } from '@/components/insights/charts';
import { Num } from '@/components/insights/Num';
import { Crumbs } from '@/components/insights/PeriodBar';
import type { Target } from '@/lib/attention';
import { PANTRY_VIEWS, periodDates, type Period } from '@/lib/insights/drill';
import { locationContentsQuery, stockFlowQuery, velocityQuery, type StockFlow } from '@/lib/insights/queries';
import { categoriesQuery } from '@/lib/money/queries';
import { formatQty } from '@/lib/pantry/units';
import { cn } from '@/lib/utils';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, areaTo, lkr } from './common';

/** The record level for stock: the journal, filtered to the product, reason and period. */
function journalTo(p: Period, productId?: string, reason?: 'consume' | 'waste' | 'purchase'): Target {
  const d = periodDates(p);
  return { to: '/pantry/journal', search: { product: productId, reason, from: d.from, to: d.to } };
}

function sum(rows: StockFlow[], flow: StockFlow['flow']) {
  return rows.filter((r) => r.flow === flow).reduce((s, r) => s + r.value, 0);
}

/** Pantry: bought vs consumed vs wasted, waste by category, how fast things go, stock by place. */
export function PantryArea({ search, period, membership }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const view = search.view ?? 'flow';
  const flow = useQuery(stockFlowQuery(householdId));
  const velocity = useQuery({ ...velocityQuery(householdId), enabled: view === 'velocity' });
  const places = useQuery({ ...locationContentsQuery(householdId), enabled: view === 'places' });
  const categories = useQuery(categoriesQuery(householdId));

  const tabs = (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('insights.pantry.viewLabel')}>
      {PANTRY_VIEWS.map((v) => (
        <Link
          key={v}
          to="/insights/$area"
          params={{ area: 'pantry' }}
          search={{ from: search.from, to: search.to, view: v === 'flow' ? undefined : v }}
          className={cn(
            'rounded-full border px-3 py-1 text-[13px]',
            view === v ? 'accent-pill border-transparent text-text' : 'border-line-2 text-muted hover:text-text',
          )}
        >
          {t(`insights.pantry.views.${v}`)}
        </Link>
      ))}
    </div>
  );

  if (flow.isError) return <LoadError />;
  if (!flow.data) return <Loading />;
  const rows = flow.data.filter((r) => r.month >= period.from && r.month <= period.to);
  const bought = sum(rows, 'bought');
  const consumed = sum(rows, 'consumed');
  const wasted = sum(rows, 'wasted');

  const perProduct = (f: StockFlow['flow'], filter?: (r: StockFlow) => boolean) => {
    const m = new Map<string, { name: string; value: number; qty: number; unit: string }>();
    for (const r of rows.filter((x) => x.flow === f && (!filter || filter(x)))) {
      const cur = m.get(r.product_id) ?? { name: r.product_name, value: 0, qty: 0, unit: r.unit_code };
      cur.value += r.value;
      cur.qty += r.qty;
      m.set(r.product_id, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].value - a[1].value);
  };

  let body;
  if (view === 'flow') {
    body = (
      <>
        <Section title={t('insights.pantry.flowTitle')}>
          {rows.length === 0 ? (
            <Empty>{t('insights.pantry.empty')}</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label={t('insights.pantry.bought')}>
                <Num value={bought} whole to={journalTo(period, undefined, 'purchase')} />
              </Figure>
              <Figure label={t('insights.pantry.consumed')}>
                <Num value={consumed} whole to={journalTo(period, undefined, 'consume')} />
              </Figure>
              <Figure label={t('insights.pantry.wasted')}>
                <Num value={wasted} whole to={areaTo('pantry', { from: search.from, to: search.to, view: 'waste' })} />
              </Figure>
              <Figure label={t('insights.pantry.stockpiling')} hint={t('insights.pantry.stockpilingHint')}>
                {consumed > 0 ? (
                  <Num value={bought / consumed} format={(v) => `${v.toFixed(2)}×`} to={journalTo(period, undefined, 'purchase')} />
                ) : (
                  '—'
                )}
              </Figure>
            </div>
          )}
        </Section>
        {perProduct('consumed').length > 0 && (
          <Section title={t('insights.pantry.consumedBy')}>
            <BarList
              label={t('insights.pantry.consumedBy')}
              format={lkr}
              rows={perProduct('consumed').map(([id, p]) => ({
                key: id,
                label: p.name,
                sub: formatQty(p.qty, { code: p.unit }),
                value: p.value,
                to: journalTo(period, id, 'consume'),
              }))}
            />
          </Section>
        )}
      </>
    );
  } else if (view === 'waste') {
    const cats = categories.data ?? [];
    const catName = (id: string | null) => (id ? cats.find((c) => c.id === id)?.name : null) ?? t('insights.uncategorised');
    const wastedRows = rows.filter((r) => r.flow === 'wasted');
    let list;
    if (!search.cat) {
      const m = new Map<string, number>();
      for (const r of wastedRows) m.set(r.top_category_id ?? 'none', (m.get(r.top_category_id ?? 'none') ?? 0) + r.value);
      list = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ key: k, label: catName(k === 'none' ? null : k), value: v, to: areaTo('pantry', { ...search, cat: k }) }));
    } else {
      const inCat = (r: StockFlow) => (r.top_category_id ?? 'none') === search.cat;
      const eaten = new Map(perProduct('consumed', inCat).map(([id, p]) => [id, p.qty]));
      list = perProduct('wasted', inCat).map(([id, p]) => {
        const spoil = p.qty / (p.qty + (eaten.get(id) ?? 0));
        return {
          key: id,
          label: p.name,
          sub: t('insights.pantry.spoilRate', { pct: Math.round(spoil * 100) }),
          value: p.value,
          to: journalTo(period, id, 'waste'),
        };
      });
    }
    body = (
      <>
        <Crumbs
          area="pantry"
          search={search}
          labels={{ cat: search.cat ? catName(search.cat === 'none' ? null : search.cat) : undefined }}
          period={period}
          locale={locale}
        />
        <Section title={t('insights.pantry.wasteTitle')}>
          {list.length === 0 ? <Empty>{t('insights.pantry.noWaste')}</Empty> : <BarList label={t('insights.pantry.wasteTitle')} format={lkr} rows={list} />}
        </Section>
      </>
    );
  } else if (view === 'velocity') {
    body = (
      <Section title={t('insights.pantry.velocityTitle')}>
        {velocity.isError ? (
          <LoadError />
        ) : !velocity.data ? (
          <Loading />
        ) : velocity.data.length === 0 ? (
          <Empty>{t('insights.pantry.velocityEmpty')}</Empty>
        ) : (
          <BarList
            label={t('insights.pantry.velocityTitle')}
            format={(v) => t('insights.pantry.days', { count: Math.round(v) })}
            rows={velocity.data.map((v) => ({
              key: v.product_id,
              label: v.product_name,
              sub: t('insights.pantry.perDay', { qty: formatQty(v.per_day ?? 0, { code: v.unit_code }) }),
              value: v.days_to_empty ?? 0,
              valueText: v.days_to_empty === null ? '—' : t('insights.pantry.days', { count: v.days_to_empty }),
              tone: v.days_to_empty !== null && v.days_to_empty < 5 ? 'caution' : 'default',
              to: { to: '/pantry/$productId', params: { productId: v.product_id } },
            }))}
          />
        )}
      </Section>
    );
  } else {
    body = (
      <Section title={t('insights.pantry.placesTitle')}>
        {places.isError ? (
          <LoadError />
        ) : !places.data ? (
          <Loading />
        ) : places.data.filter((p) => p.stock_value > 0).length === 0 ? (
          <Empty>{t('insights.pantry.placesEmpty')}</Empty>
        ) : (
          <BarList
            label={t('insights.pantry.placesTitle')}
            format={lkr}
            rows={places.data
              .filter((p) => p.stock_value > 0)
              .sort((a, b) => b.stock_value - a.stock_value)
              .map((p) => ({
                key: p.location_id,
                label: p.name,
                sub: t('insights.pantry.lots', { count: p.lots }),
                value: p.stock_value,
                to: { to: '/places/$placeId', params: { placeId: p.location_id } },
              }))}
          />
        )}
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {tabs}
      {body}
    </div>
  );
}
