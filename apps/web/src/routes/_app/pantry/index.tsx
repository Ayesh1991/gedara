import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { History, ListChecks, Plus, ScanLine, Search, ShoppingBasket } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { StatTile } from '@/components/aurora/StatTile';
import { Money } from '@/components/money/bits';
import { CouldntSync } from '@/components/offline/OfflineSync';
import { usePantry, useStockAction } from '@/components/pantry/bits';
import { ProductActionsSheet, ProductCard } from '@/components/pantry/ProductCard';
import { ProductForm } from '@/components/pantry/ProductForm';
import { useShoppingList } from '@/components/spine/useShopping';
import { StockSheet, type StockMode } from '@/components/pantry/StockSheet';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { consume, type Product } from '@/lib/pantry/queries';
import { ATTENTION, matchesFilter, stockStatuses, type StatusFilter, type StockStatus } from '@/lib/pantry/status';
import { formatQty } from '@/lib/pantry/units';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme/ThemeProvider';
import { textParam } from '@/lib/search';

const FILTERS = ['all', 'attention', 'expired', 'bbPassed', 'dueSoon', 'belowMin', 'opened', 'out', 'archived'] as const;
type Filter = (typeof FILTERS)[number];

const text = textParam;

const SearchSchema = z.object({
  q: text(80).optional(),
  filter: z.enum(FILTERS).optional(),
  /** Open "New product" (value '1'), prefilled with a scanned barcode otherwise. */
  new: text(64).optional(),
});

export const Route = createFileRoute('/_app/pantry/')({
  validateSearch: SearchSchema,
  component: PantryPage,
});

const URGENCY: Record<StockStatus, number> = { expired: 0, bbPassed: 1, dueSoon: 2, belowMin: 3, opened: 4, out: 5 };

function PantryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: '/pantry/' });
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const pantry = usePantry(householdId);
  const list = useShoppingList(householdId, canWrite);
  const toBuy = (list.data ?? []).filter((i) => !i.done && !i.dismissed).length;
  const { run } = useStockAction(householdId);
  const { prefs, motion } = useTheme();
  const [menuFor, setMenuFor] = useState<Product | null>(null);
  const [sheet, setSheet] = useState<{ mode: StockMode; product: Product } | null>(null);
  const filter: Filter = search.filter ?? 'all';
  const createdRef = useRef<string | null>(null);

  const setSearch = (patch: Partial<z.infer<typeof SearchSchema>>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const rows = useMemo(() => {
    const products = pantry.products.data ?? [];
    return products.map((p) => ({
      product: p,
      statuses: stockStatuses(
        { due_type: p.due_type, next_due: p.stock.nextDue, qty: p.stock.qty, qty_opened: p.stock.qtyOpened, below_min: p.stock.belowMin },
        today,
      ),
    }));
  }, [pantry.products.data, today]);

  const active = rows.filter((r) => !r.product.archived);
  const inStock = active.filter((r) => r.product.stock.qty > 0);
  const value = inStock.reduce((s, r) => s + r.product.stock.value, 0);
  const unpriced = inStock.filter((r) => r.product.stock.unpricedQty > 0).length;
  const attention = active.filter((r) => r.statuses.some((s) => ATTENTION.has(s))).length;

  const shown = useMemo(() => {
    const q = search.q?.trim().toLowerCase();
    return rows
      .filter((r) => (filter === 'archived' ? r.product.archived : !r.product.archived))
      .filter((r) => filter === 'archived' || matchesFilter(r.statuses, filter as StatusFilter))
      .filter(
        (r) =>
          !q ||
          r.product.name.toLowerCase().includes(q) ||
          (r.product.name_si ?? '').toLowerCase().includes(q) ||
          r.product.code.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const ua = Math.min(...a.statuses.map((s) => URGENCY[s]), 9);
        const ub = Math.min(...b.statuses.map((s) => URGENCY[s]), 9);
        return ua - ub || a.product.name.localeCompare(b.product.name);
      });
  }, [rows, filter, search.q]);

  function consumeAll(p: Product) {
    const unit = pantry.units.data?.get(p.stock_unit_id);
    void run(
      (label) => consume({ household_id: householdId, product_id: p.id, all: true }, label),
      (r) => t('pantry.done.used', { qty: formatQty(r.qty ?? p.stock.qty, unit), name: p.name }),
      unit,
    );
  }

  function quickUse(p: Product) {
    const unit = pantry.units.data?.get(p.stock_unit_id);
    void run(
      (label) => consume({ household_id: householdId, product_id: p.id, qty: p.quick_consume_qty }, label),
      (r) => t('pantry.done.used', { qty: formatQty(r.qty ?? p.quick_consume_qty, unit), name: p.name }),
      unit,
    );
  }

  const hasProducts = active.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.pantry')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('pantry.intro')}</p>
        </div>
        <div className="flex gap-2.5">
          <Link to="/pantry/list" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            <ListChecks className="h-4 w-4" aria-hidden />
            {t('shopping.short')}
            {toBuy > 0 && <span className="tabular rounded-full bg-due/20 px-1.5 text-[11.5px] text-due">{toBuy}</span>}
          </Link>
          <Link to="/pantry/journal" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            <History className="h-4 w-4" aria-hidden />
            {t('pantry.journal.short')}
          </Link>
          {canWrite && (
            <Button variant="primary" size="sm" onClick={() => setSearch({ new: '1' })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('pantry.newProduct')}
            </Button>
          )}
        </div>
      </div>

      <CouldntSync householdId={householdId} />

      {pantry.error ? (
        <Card className="text-[14px] text-red">{t('pantry.loadError')}</Card>
      ) : !pantry.ready ? (
        <div className="grid gap-2.5 md:grid-cols-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass h-[86px] animate-pulse rounded-[var(--r)]" />
          ))}
        </div>
      ) : !hasProducts && filter !== 'archived' ? (
        <Card className="flex flex-col items-start gap-3">
          <div className="brand-gradient flex h-12 w-12 items-center justify-center rounded-2xl text-[#05070F]">
            <ShoppingBasket className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="font-display text-[20px] font-semibold">{t('pantry.emptyTitle')}</h2>
          <p className="max-w-prose text-[14.5px] leading-relaxed text-[#a5b0d0]">{t('pantry.emptyBody')}</p>
          {canWrite && (
            <div className="flex flex-wrap gap-2.5">
              <Button variant="accent" onClick={() => setSearch({ new: '1' })}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('pantry.addFirst')}
              </Button>
              <Link to="/scan" className={buttonVariants({ variant: 'secondary' })}>
                <ScanLine className="h-4 w-4" aria-hidden />
                {t('pantry.scanFirst')}
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <>
          <section aria-label={t('pantry.summary')} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4">
            <StatTile
              label={t('pantry.stats.inStock')}
              value={<span className="tabular text-[21px] lg:text-[24px]">{inStock.length}</span>}
              footer={t('pantry.stats.ofProducts', { count: active.length })}
            />
            <StatTile
              label={t('pantry.stats.value')}
              value={<Money value={value} whole className="text-[19px] sm:text-[21px] lg:text-[24px]" />}
              empty={value === 0}
              footer={unpriced > 0 ? t('pantry.stats.unpriced', { count: unpriced }) : undefined}
            />
            <div className="col-span-2 sm:col-span-1">
              <StatTile
                highlight={attention > 0}
                label={t('pantry.stats.attention')}
                value={<span className="tabular text-[21px] lg:text-[24px]">{attention}</span>}
                footer={
                  attention > 0 ? (
                    <button type="button" className="text-accent-b underline" onClick={() => setSearch({ filter: 'attention' })}>
                      {t('pantry.stats.show')}
                    </button>
                  ) : (
                    t('pantry.stats.allGood')
                  )
                }
              />
            </div>
          </section>

          <div className="flex flex-col gap-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                type="search"
                aria-label={t('pantry.search')}
                placeholder={t('pantry.search')}
                className="pl-10"
                value={search.q ?? ''}
                onChange={(e) => setSearch({ q: e.target.value || undefined })}
              />
            </div>
            <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0" role="group" aria-label={t('pantry.filterLabel')}>
              <div className="flex gap-1.5 pb-1">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setSearch({ filter: f === 'all' ? undefined : f })}
                    className={cn(
                      'h-9 shrink-0 rounded-full border px-3.5 text-[13px] whitespace-nowrap',
                      filter === f ? 'accent-pill border-transparent text-text' : 'border-line-2 text-muted',
                    )}
                  >
                    {t(`pantry.filters.${f}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <Card className="text-center text-[14.5px] text-muted">{t('pantry.noMatches')}</Card>
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {shown.map(({ product, statuses }) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  unit={pantry.units.data?.get(product.stock_unit_id)}
                  statuses={statuses}
                  photo={pantry.photos.data?.get(product.id)}
                  today={today}
                  locale={locale}
                  canWrite={canWrite}
                  onQuickUse={() => quickUse(product)}
                  onMore={() => setMenuFor(product)}
                  onUseAll={() => consumeAll(product)}
                  swipe={prefs.swipe}
                  motion={motion}
                />
              ))}
            </div>
          )}
        </>
      )}

      <ProductActionsSheet
        product={menuFor}
        open={Boolean(menuFor)}
        onClose={() => setMenuFor(null)}
        onPick={(mode) => {
          if (menuFor) setSheet({ mode, product: menuFor });
          setMenuFor(null);
        }}
      />
      {sheet && pantry.units.data && pantry.conversions.data && (
        <StockSheet
          open
          onClose={() => setSheet(null)}
          mode={sheet.mode}
          product={sheet.product}
          householdId={householdId}
          timezone={timezone}
          units={pantry.units.data}
          conversions={pantry.conversions.data}
          tree={pantry.tree}
        />
      )}
      {pantry.units.data && (
        <ProductForm
          open={Boolean(search.new)}
          onClose={() => {
            // A new product opens its page (to add stock); otherwise just close the form.
            const created = createdRef.current;
            createdRef.current = null;
            if (created) void navigate({ to: '/pantry/$productId', params: { productId: created } });
            else setSearch({ new: undefined });
          }}
          householdId={householdId}
          units={pantry.units.data}
          categories={pantry.categories.data ?? []}
          products={pantry.products.data ?? []}
          tree={pantry.tree}
          barcode={search.new && search.new !== '1' ? search.new : null}
          onSaved={(p) => {
            createdRef.current = p.id || null;
          }}
        />
      )}
    </div>
  );
}
