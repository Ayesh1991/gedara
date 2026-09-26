import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronRight, CircleCheck, ListChecks, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Ring, Sparkline, smoothPath } from '@/components/aurora/charts';
import { StatTile } from '@/components/aurora/StatTile';
import { ActivityList } from '@/components/attention/ActivityList';
import { AttentionRow } from '@/components/attention/AttentionRow';
import { TargetLink } from '@/components/insights/Num';
import { Money } from '@/components/money/bits';
import { useDriveSync } from '@/components/scan/useDriveSync';
import { useShoppingList } from '@/components/spine/useShopping';
import { Card } from '@/components/ui/card';
import { knownItems } from '@/lib/attention';
import { activityQuery, attentionQuery, budgetMonthQuery } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';
import { cashflowQuery, type MonthFlow } from '@/lib/money/queries';
import { productsQuery } from '@/lib/pantry/queries';
import { placesQuery } from '@/lib/places';
import { driveSourceQuery } from '@/lib/scan/queries';
import { assetsQuery } from '@/lib/things/queries';
import { addMonths, dayPart, firstName, formatMonth, hourIn, todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/')({
  component: Pulse,
});

// Ghost shapes for empty states: they show where data will appear, never pretend to be data.
const GHOST_TREND = [3, 4, 3.6, 5, 4.6, 6];
const GHOST_IN = [70, 72, 71, 80, 78, 74];
const GHOST_OUT = [50, 58, 46, 64, 55, 48];

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{children}</p>;
}

/** Pantry value: real stock only; an empty tile until something is in stock. */
function PantryTile({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const products = useQuery(productsQuery(householdId));
  const inStock = (products.data ?? []).filter((p) => !p.archived && p.stock.qty > 0);
  const value = inStock.reduce((s, p) => s + p.stock.value, 0);
  const has = inStock.length > 0;
  return (
    <Link to="/insights/$area" params={{ area: 'pantry' }} search={{ view: 'places' }} className="contents">
      <StatTile
        empty={!has}
        label={t('home.pantryValue')}
        value={has ? <Money value={value} whole /> : 'Rs —'}
        footer={has ? t('home.pantryLine', { count: inStock.length }) : t('home.noPantryYet')}
      />
    </Link>
  );
}

const GONE = new Set(['sold', 'disposed', 'lost']);

/** Things: how many and what they're worth now (real rows only). */
function ThingsTile({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const assets = useQuery(assetsQuery(householdId));
  const owned = (assets.data ?? []).filter((a) => !GONE.has(a.status));
  const value = owned.reduce((s, a) => s + (a.current_value ?? 0), 0);
  const has = owned.length > 0;
  return (
    <Link to="/insights/$area" params={{ area: 'things' }} className="contents">
      <StatTile
        empty={!has}
        label={t('home.things')}
        value={has ? <Money value={value} whole /> : 'Rs —'}
        footer={has ? t('home.thingsLine', { count: owned.length }) : t('home.noThingsYet')}
      />
    </Link>
  );
}

/** Attention: the top of the feed from the database (the same list the 07:00 push summarises). */
function AttentionCard({ householdId, canWrite, today }: { householdId: string; canWrite: boolean; today: string }) {
  const { t } = useTranslation();
  // Opening Home keeps the automatic "below minimum" list items in sync (Phase 4).
  const list = useShoppingList(householdId, canWrite);
  // New scans in the Bill Scanner's Drive folder show up as "N scanned files to import".
  const drive = useQuery({ ...driveSourceQuery(householdId), enabled: canWrite });
  useDriveSync(householdId, canWrite && Boolean(drive.data));
  const toBuy = (list.data ?? []).filter((i) => !i.done && !i.dismissed).length;
  const feed = useQuery({ ...attentionQuery(householdId), refetchOnWindowFocus: true });
  const items = knownItems(feed.data ?? []);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-[17px] font-semibold">{t('home.attention')}</h2>
        {items.length > 0 && (
          <Link to="/attention" className="text-[13px] text-accent-b hover:underline">
            {t('home.seeAll', { count: items.length })}
          </Link>
        )}
      </div>
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.slice(0, 5).map((i) => (
            <AttentionRow key={i.item_key} item={i} householdId={householdId} canWrite={canWrite} today={today} />
          ))}
        </ul>
      )}
      {toBuy > 0 && (
        <Link to="/pantry/list" className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3.5 py-3 hover:bg-white/[0.07]">
          <ListChecks className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1 text-[14.5px]">{t('home.toBuy', { count: toBuy })}</div>
          <ChevronRight className="h-5 w-5 text-muted" aria-hidden />
        </Link>
      )}
      {feed.data && items.length === 0 && (
        <div className="flex items-center gap-3 rounded-2xl bg-teal/[0.07] px-3.5 py-3">
          <CircleCheck className="h-5 w-5 shrink-0 text-teal" aria-hidden />
          <EmptyNote>{t('home.attentionEmpty')}</EmptyNote>
        </div>
      )}
    </Card>
  );
}

/** Budget burn: this month's spending against each main category's budget. */
function BudgetCard({ householdId, month }: { householdId: string; month: string }) {
  const { t } = useTranslation();
  const budgets = useQuery(budgetMonthQuery(householdId, month));
  const rows = (budgets.data ?? [])
    .filter((b) => b.budget !== null)
    .sort((a, b) => b.spent / b.budget! - a.spent / a.budget!);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-[17px] font-semibold">{t('home.budget')}</h2>
        <Link to="/money/budgets" search={{ month }} className="text-[13px] text-accent-b hover:underline">
          {rows.length ? t('home.budgetEdit') : t('home.budgetSet')}
        </Link>
      </div>
      {rows.length === 0 ? (
        <>
          <div className="flex flex-col gap-3.5" aria-hidden>
            {[72, 48, 88, 36].map((w) => (
              <div key={w} className="flex flex-col gap-2">
                <div className="h-2.5 w-24 rounded-full bg-white/[0.06]" />
                <div className="h-2 rounded-full bg-white/[0.06]">
                  <div
                    className="h-2 rounded-full opacity-30"
                    style={{ width: `${w}%`, background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))' }}
                  />
                </div>
              </div>
            ))}
          </div>
          <EmptyNote>{t('home.budgetEmpty')}</EmptyNote>
        </>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.slice(0, 5).map((b) => {
            const used = b.spent / b.budget!;
            return (
              <li key={b.category_id}>
                <TargetLink
                  target={{ to: '/insights/$area', params: { area: 'spend' }, search: { cat: b.category_id, from: month, to: month } }}
                  className="flex flex-col gap-1.5 rounded-xl px-1 py-1.5 hover:bg-white/[0.04]"
                >
                  <span className="flex items-baseline gap-2 text-[14px]">
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <span className="tabular text-[12.5px] text-muted">
                      {formatLKR(b.spent, { whole: true })} / {formatLKR(b.budget!, { whole: true })}
                    </span>
                  </span>
                  <span className="block h-2 rounded-full bg-white/[0.06]" aria-hidden>
                    <span
                      className={used > 1 ? 'block h-2 rounded-full bg-red' : used >= 0.9 ? 'block h-2 rounded-full bg-caution' : 'block h-2 rounded-full'}
                      style={{
                        width: `${Math.min(100, Math.max(2, used * 100))}%`,
                        ...(used < 0.9 ? { background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))' } : {}),
                      }}
                    />
                  </span>
                </TargetLink>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Recent activity: the household timeline (bills, stock, things, places), refreshed every minute. */
function ActivityCard({ householdId, locale }: { householdId: string; locale: string }) {
  const { t } = useTranslation();
  const activity = useQuery({ ...activityQuery(householdId, 8), refetchInterval: 60_000 });
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[17px] font-semibold">{t('home.activity')}</h2>
        <span className="tabular flex items-center gap-1.5 text-[11px] text-teal">
          <span className="h-[7px] w-[7px] rounded-full bg-teal shadow-[0_0_10px_var(--teal)]" />
          {t('home.live')}
        </span>
      </div>
      {activity.data && activity.data.length > 0 ? (
        <ActivityList rows={activity.data} locale={locale} />
      ) : (
        <div className="flex gap-3.5">
          <div className="flex flex-col items-center pt-1" aria-hidden>
            <span className="h-3 w-3 rounded-full border-2 border-accent-b" />
            <span className="w-0.5 flex-1 bg-gradient-to-b from-[var(--accent-b)] to-transparent opacity-50" />
          </div>
          <EmptyNote>{t('home.activityEmpty')}</EmptyNote>
        </div>
      )}
    </Card>
  );
}

/** Places is not in the phone dock (§5.1), so Home links to it — with real counts only. */
function PlacesCard({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const places = useQuery(placesQuery(householdId));
  const total = places.data?.length ?? 0;
  const rooms = places.data?.filter((p) => !p.parent_id).length ?? 0;
  return (
    <Link to="/places" className="block">
      <Card className="flex items-center gap-4 transition-colors hover:border-white/25">
        <div className="brand-gradient flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[#05070F]">
          <MapPin className="h-6 w-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[17px] font-semibold">{t('nav.places')}</div>
          <div className="tabular text-[13px] text-muted">
            {places.isPending ? '…' : total ? t('home.placesSummary', { count: total, rooms }) : t('home.placesEmpty')}
          </div>
        </div>
        <ChevronRight className="h-5 w-5 text-muted" aria-hidden />
      </Card>
    </Link>
  );
}

/** The last six calendar months ending with this one, with zeros where nothing was recorded. */
function lastSixMonths(flow: MonthFlow[] | undefined, thisMonth: string): MonthFlow[] {
  return Array.from({ length: 6 }, (_, i) => {
    const month = addMonths(thisMonth, i - 5);
    return flow?.find((f) => f.month === month) ?? { month, income: 0, spent: 0, net: 0, bills: 0 };
  });
}

function Pulse() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { timezone, locale, id: householdId } = membership.household;
  const part = dayPart(hourIn(timezone));
  const name = firstName(membership.displayName, membership.email);
  const flow = useQuery(cashflowQuery(householdId));
  const thisMonth = todayIn(timezone).slice(0, 7);
  const six = lastSixMonths(flow.data, thisMonth);
  const now = six.at(-1)!;
  const hasMoney = six.some((m) => m.bills > 0 || m.income > 0);
  const top = Math.max(1, ...six.map((m) => Math.max(m.income, m.spent)));
  const budgets = useQuery(budgetMonthQuery(householdId, thisMonth));
  const budgeted = (budgets.data ?? []).filter((b) => b.budget !== null);
  const budgetTotal = budgeted.reduce((s, b) => s + b.budget!, 0);
  const burn = budgetTotal > 0 ? budgeted.reduce((s, b) => s + b.spent, 0) / budgetTotal : 0;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight lg:text-[32px]">
        {t(`home.greeting.${part}`, { name })}
      </h1>

      <section aria-label={t('home.net')} className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Link to="/insights/$area" params={{ area: 'cashflow' }} search={{ from: thisMonth }} className="contents">
          <StatTile
            highlight
            empty={!hasMoney}
            label={t('home.net')}
            value={hasMoney ? <Money value={now.net} whole /> : 'Rs —'}
            footer={hasMoney ? t('home.incomeLine', { amount: formatLKR(now.income, { whole: true }) }) : t('home.noMoneyYet')}
            side={<Sparkline values={hasMoney ? six.map((m) => m.net) : GHOST_TREND} width={88} height={30} ghost={!hasMoney} />}
          />
        </Link>
        <Link to="/insights/$area" params={{ area: 'spend' }} search={{ from: thisMonth }} className="contents">
          <StatTile
            empty={!hasMoney}
            label={t('home.spent')}
            value={hasMoney ? <Money value={now.spent} whole /> : 'Rs —'}
            footer={hasMoney ? t('home.billsLine', { count: now.bills }) : t('home.noMoneyYet')}
            side={<Ring value={burn} size={60} label={t('home.budgetRing', { pct: Math.round(burn * 100) })} />}
          />
        </Link>
        <PantryTile householdId={membership.household.id} />
        <ThingsTile householdId={membership.household.id} />
      </section>

      <PlacesCard householdId={membership.household.id} />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <h2 className="flex-1 font-display text-[17px] font-semibold">{t('home.cashFlow')}</h2>
            <span className="flex items-center gap-1.5 text-[12.5px] text-[#a5b0d0]">
              <span className="h-2 w-2 rounded-full bg-accent-b" />
              {t('home.income')}
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-[#a5b0d0]">
              <span className="h-2 w-2 rounded-full bg-accent-a" />
              {t('home.outgoing')}
            </span>
          </div>
          <div className="relative">
            <svg width="100%" height="170" viewBox="0 0 700 170" preserveAspectRatio="none" aria-hidden>
              <path
                d="M0 30H700M0 85H700M0 140H700"
                style={{ stroke: 'var(--line)' }}
                strokeDasharray="3 6"
                fill="none"
              />
              <path
                d={hasMoney ? smoothPath(six.map((m) => m.income), 700, 150, 20, [0, top]) : smoothPath(GHOST_IN, 700, 150, 20)}
                fill="none"
                strokeWidth={hasMoney ? 2.5 : 2}
                strokeDasharray={hasMoney ? undefined : '4 7'}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: hasMoney ? 'var(--accent-b)' : 'color-mix(in srgb, var(--accent-b) 45%, transparent)' }}
              />
              <path
                d={hasMoney ? smoothPath(six.map((m) => m.spent), 700, 150, 20, [0, top]) : smoothPath(GHOST_OUT, 700, 150, 20)}
                fill="none"
                strokeWidth={hasMoney ? 2.5 : 2}
                strokeDasharray={hasMoney ? undefined : '4 7'}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: hasMoney ? 'var(--accent-a)' : 'color-mix(in srgb, var(--accent-a) 45%, transparent)' }}
                transform={hasMoney ? undefined : 'translate(0 16)'}
              />
            </svg>
            {!hasMoney && (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                <div className="glass-strong max-w-sm rounded-2xl px-4 py-3">
                  <EmptyNote>{t('home.cashFlowEmpty')}</EmptyNote>
                </div>
              </div>
            )}
          </div>
          <div className="tabular flex justify-between text-[11.5px] text-faint">
            {six.map((m) => (
              <Link
                key={m.month}
                to="/insights/$area"
                params={{ area: 'cashflow' }}
                search={{ from: m.month }}
                className="rounded px-1 hover:text-text"
                title={`${formatMonth(m.month, locale)}: ${formatLKR(m.income, { whole: true })} / ${formatLKR(m.spent, { whole: true })}`}
              >
                {formatMonth(m.month, locale, true)}
              </Link>
            ))}
          </div>
        </Card>

        <BudgetCard householdId={householdId} month={thisMonth} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AttentionCard householdId={householdId} canWrite={membership.role !== 'viewer'} today={todayIn(timezone)} />
        <ActivityCard householdId={householdId} locale={locale} />
      </section>
    </div>
  );
}
