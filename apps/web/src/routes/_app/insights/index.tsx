import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Boxes, ChartNoAxesColumn, MapPin, Package, Receipt, ShoppingBasket, TrendingUp, Zap, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pct } from '@/components/insights/areas/common';
import { Num, TargetLink } from '@/components/insights/Num';
import type { Target } from '@/lib/attention';
import { periodOf, type Area } from '@/lib/insights/drill';
import { personalInflation } from '@/lib/insights/inflation';
import { locationContentsQuery, priceMonthQuery, stockFlowQuery, utilityQuery } from '@/lib/insights/queries';
import { cashflowQuery } from '@/lib/money/queries';
import { assetsQuery } from '@/lib/things/queries';
import { todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/insights/')({
  component: InsightsHome,
});

const ICONS: Record<Area, LucideIcon> = {
  cashflow: TrendingUp,
  spend: Receipt,
  prices: ChartNoAxesColumn,
  pantry: ShoppingBasket,
  things: Package,
  utilities: Zap,
  places: MapPin,
};

function AreaCard({ area, figure, note }: { area: Area; figure: ReactNode; note: string }) {
  const { t } = useTranslation();
  const Icon = ICONS[area];
  const to: Target = { to: '/insights/$area', params: { area } };
  return (
    <div className="glass flex flex-col gap-3 rounded-[var(--r)] p-5">
      <TargetLink target={to} className="flex items-center gap-3 hover:text-accent-b">
        <span className="brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[#05070F]">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <span className="font-display text-[17px] font-semibold">{t(`insights.areas.${area}.title`)}</span>
      </TargetLink>
      <div className="tabular text-[24px] leading-tight font-semibold">{figure}</div>
      <p className="text-[13px] text-muted">{note}</p>
    </div>
  );
}

/** Insights (MASTER_PLAN §6): one card per area, each headline number opens its drill-down. */
function InsightsHome() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone } = membership.household;
  const today = todayIn(timezone);
  const month = today.slice(0, 7);
  const year = periodOf({}, today);
  const flow = useQuery(cashflowQuery(householdId));
  const assets = useQuery(assetsQuery(householdId));
  const stock = useQuery(stockFlowQuery(householdId));
  const prices = useQuery(priceMonthQuery(householdId));
  const utilities = useQuery(utilityQuery(householdId));
  const places = useQuery(locationContentsQuery(householdId));

  const area = (a: Area, search: Record<string, string> = {}): Target => ({ to: '/insights/$area', params: { area: a }, search });
  const dash = <span className="text-faint">—</span>;

  const now = flow.data?.find((f) => f.month === month);
  const spent12 = (flow.data ?? []).filter((f) => f.month >= year.from).reduce((s, f) => s + f.spent, 0);
  const owned = (assets.data ?? []).filter((a) => !['sold', 'disposed', 'lost'].includes(a.status));
  const consumed = (stock.data ?? []).filter((r) => r.month === month && r.flow === 'consumed').reduce((s, r) => s + r.value, 0);
  const inflation = personalInflation(
    (prices.data ?? []).map((r) => ({ product_id: r.product_id, product_name: r.product_name, month: r.month, qty: r.qty, spent: r.spent })),
  );
  const lastBill = utilities.data?.at(-1);
  const usedPlaces = (places.data ?? []).filter((p) => p.lots + p.assets > 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.insights')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('insights.intro')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AreaCard
          area="cashflow"
          figure={now ? <Num value={now.net} whole signed to={area('cashflow', { from: month })} /> : dash}
          note={t('insights.cards.cashflow')}
        />
        <AreaCard
          area="spend"
          figure={spent12 > 0 ? <Num value={spent12} whole to={area('spend')} /> : dash}
          note={t('insights.cards.spend')}
        />
        <AreaCard
          area="prices"
          figure={inflation.change !== null ? <Num value={inflation.change} format={pct} to={area('prices')} /> : dash}
          note={t('insights.cards.prices')}
        />
        <AreaCard
          area="pantry"
          figure={consumed > 0 ? <Num value={consumed} whole to={area('pantry', { from: month })} /> : dash}
          note={t('insights.cards.pantry')}
        />
        <AreaCard
          area="things"
          figure={
            owned.length > 0 ? (
              <Num value={owned.reduce((s, a) => s + (a.current_value ?? 0), 0)} whole to={area('things')} />
            ) : (
              dash
            )
          }
          note={t('insights.cards.things')}
        />
        <AreaCard
          area="utilities"
          figure={
            lastBill ? (
              <Num value={lastBill.amount} whole to={{ to: '/money/tx/$txId', params: { txId: lastBill.transaction_id } }} />
            ) : (
              dash
            )
          }
          note={lastBill ? t('insights.cards.utilitiesLast', { name: lastBill.rule_name }) : t('insights.cards.utilities')}
        />
        <AreaCard
          area="places"
          figure={
            usedPlaces.length > 0 ? (
              <Num
                value={usedPlaces.reduce((s, p) => s + p.stock_value + p.asset_value, 0)}
                whole
                to={area('places')}
              />
            ) : (
              dash
            )
          }
          note={t('insights.cards.places')}
        />
      </div>
      <p className="flex items-center gap-2 text-[12.5px] text-faint">
        <Boxes className="h-4 w-4" aria-hidden />
        {t('insights.everyNumber')}
      </p>
    </div>
  );
}
