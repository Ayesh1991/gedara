import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShoppingBasket } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { placeLotsQuery, type Product } from '@/lib/pantry/queries';
import { todayIn } from '@/lib/time';
import { DueText, ProductArt, Qty, StatusChip, usePantry } from './bits';
import { StockSheet, type StockMode } from './StockSheet';

/** "What's in this box" for the pantry (MASTER_PLAN §4 #2): stock kept here, earliest due first. */
export function PlaceStock({
  householdId,
  placeId,
  timezone,
  locale,
  canWrite,
}: {
  householdId: string;
  placeId: string;
  timezone: string;
  locale: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const pantry = usePantry(householdId);
  const lots = useQuery(placeLotsQuery(householdId, placeId));
  const [sheet, setSheet] = useState<{ mode: StockMode; product: Product } | null>(null);
  const today = todayIn(timezone);

  const rows = useMemo(() => {
    const byProduct = new Map<string, { qty: number; nextDue: string | null; opened: boolean }>();
    for (const l of lots.data ?? []) {
      const r = byProduct.get(l.product_id) ?? { qty: 0, nextDue: null, opened: false };
      r.qty += l.qty_remaining;
      if (l.due_date && (!r.nextDue || l.due_date < r.nextDue)) r.nextDue = l.due_date;
      if (l.opened_at) r.opened = true;
      byProduct.set(l.product_id, r);
    }
    return [...byProduct.entries()]
      .map(([id, r]) => ({ product: pantry.products.data?.find((p) => p.id === id), ...r }))
      .filter((r): r is typeof r & { product: Product } => Boolean(r.product))
      .sort((a, b) => (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999') || a.product.name.localeCompare(b.product.name));
  }, [lots.data, pantry.products.data]);

  return (
    <section className="flex flex-col gap-3" data-testid="place-stock">
      <h2 className="font-display text-[19px] font-semibold">
        {t('pantry.place.title')} <span className="tabular text-[14px] text-muted">{rows.length || ''}</span>
      </h2>
      {lots.isPending || !pantry.ready ? (
        <div className="glass h-16 animate-pulse rounded-2xl" aria-hidden />
      ) : rows.length === 0 ? (
        <Card className="flex items-center gap-3 text-[14px] text-[#a5b0d0]">
          <ShoppingBasket className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          {t('pantry.place.empty')}
        </Card>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {rows.map(({ product, qty, nextDue, opened }) => (
            <li key={product.id} className="glass flex items-center gap-3 rounded-2xl p-2.5">
              <Link to="/pantry/$productId" params={{ productId: product.id }} className="flex min-w-0 flex-1 items-center gap-3">
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl">
                  <ProductArt product={product} photo={pantry.photos.data?.get(product.id)} />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-medium">{product.name}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
                    <Qty qty={qty} unit={pantry.units.data?.get(product.stock_unit_id)} />
                    <DueText dueType={product.due_type} due={nextDue} today={today} locale={locale} />
                    {opened && <StatusChip status="opened" />}
                  </div>
                </div>
              </Link>
              {canWrite && (
                <Button size="sm" onClick={() => setSheet({ mode: 'use', product })}>
                  {t('pantry.actions.use')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
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
          placeId={placeId}
        />
      )}
    </section>
  );
}
