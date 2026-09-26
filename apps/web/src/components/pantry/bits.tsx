import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePlaces } from '@/components/places/PlaceGrid';
import { categoriesQuery } from '@/lib/money/queries';
import { formatLKR } from '@/lib/money/format';
import { outbox } from '@/lib/offline';
import {
  availableQty,
  barcodesQuery,
  conversionsQuery,
  invalidatePantry,
  pantryErrorKey,
  pantryUnitsQuery,
  productPhotosQuery,
  productsQuery,
  undoStock,
  type Product,
  type StockResult,
} from '@/lib/pantry/queries';
import { STATUS_TONE, dueState, type StockStatus } from '@/lib/pantry/status';
import { formatQty, pricePer, type Unit, type UnitMap } from '@/lib/pantry/units';
import type { EntityPhoto } from '@/lib/photos';
import { formatDay } from '@/lib/time';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';

export { fieldLabel, selectClass } from '@/components/money/bits';

/** Everything the pantry screens share: units, products, conversions, barcodes, places, photos. */
export function usePantry(householdId: string) {
  const units = useQuery(pantryUnitsQuery(householdId));
  const products = useQuery(productsQuery(householdId));
  const conversions = useQuery(conversionsQuery(householdId));
  const barcodes = useQuery(barcodesQuery(householdId));
  const photos = useQuery(productPhotosQuery(householdId));
  const categories = useQuery(categoriesQuery(householdId));
  const { places, tree } = usePlaces(householdId);
  return {
    units,
    products,
    conversions,
    barcodes,
    photos,
    categories,
    places,
    tree,
    ready: units.isSuccess && products.isSuccess && conversions.isSuccess,
    // Only an error when there is nothing to show: a failed background refresh (flaky or no network)
    // keeps the saved data on screen.
    error: (units.isError && !units.data) || (products.isError && !products.data) || (conversions.isError && !conversions.data),
  };
}

/** Runs a stock RPC, refreshes the pantry and offers the 8 s Undo (MASTER_PLAN §5.4). */
export function useStockAction(householdId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const reportError = useCallback(
    (e: unknown, unit?: Unit) => {
      const key = pantryErrorKey(e);
      const left = availableQty(e);
      toast.error(
        key === 'noStock' && left !== null && left > 0
          ? t('pantry.errors.noStockLeft', { qty: formatQty(left, unit) })
          : t(`pantry.errors.${key}`),
      );
    },
    [t],
  );

  const run = useCallback(
    async (
      action: (label: string) => Promise<StockResult>,
      message: (r: StockResult) => string,
      unit?: Unit,
    ): Promise<StockResult | null> => {
      try {
        // The label is what the queue shows if this has to wait for the network.
        const r = await action(message({ correlation_id: null }));
        // Queued (offline): say so at once — a refresh can't run now and must not hold up the message.
        if (!r.queued) await invalidatePantry(qc, householdId);
        if (r.queued && r.op_id) {
          const opId = r.op_id;
          toast(message(r), {
            description: t('offline.queued'),
            duration: UNDO_MS,
            action: {
              label: t('common.undo'),
              onClick: () => {
                void (async () => {
                  if (await outbox.remove(opId)) return toast(t('pantry.done.undone'));
                  // It synced in the meantime: undo it on the server like any other action.
                  const synced = outbox.resultOf(opId) as { correlation_id?: string } | undefined;
                  if (!synced?.correlation_id) return;
                  try {
                    await undoStock(synced.correlation_id);
                    await invalidatePantry(qc, householdId);
                    toast(t('pantry.done.undone'));
                  } catch (e) {
                    reportError(e);
                  }
                })();
              },
            },
          });
          return r;
        }
        const correlation = r.correlation_id;
        toast.success(message(r), {
          duration: UNDO_MS,
          action: correlation
            ? {
                label: t('common.undo'),
                onClick: () => {
                  undoStock(correlation)
                    .then(() => invalidatePantry(qc, householdId))
                    .then(() => toast(t('pantry.done.undone')))
                    .catch((e: unknown) => reportError(e));
                },
              }
            : undefined,
        });
        return r;
      } catch (e) {
        reportError(e, unit);
        return null;
      }
    },
    [qc, householdId, t, reportError],
  );

  return { run, reportError };
}

export function StatusChip({ status }: { status: StockStatus }) {
  const { t } = useTranslation();
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', STATUS_TONE[status])}>
      {t(`pantry.status.${status}`)}
    </span>
  );
}

/** Quantity in mono (rule 11): "1.5 kg". */
export function Qty({ qty, unit, className }: { qty: number; unit: Unit | undefined; className?: string }) {
  return <span className={cn('tabular whitespace-nowrap', className)}>{formatQty(qty, unit)}</span>;
}

/** "Rs 550.00 / kg" — prices normalised so a wrong one is obvious (§0.1 #1). */
export function UnitPrice({ unitCost, unit, className }: { unitCost: number | null | undefined; unit: Unit | undefined; className?: string }) {
  if (unitCost === null || unitCost === undefined) return null;
  const p = pricePer(unitCost, unit);
  if (!p) return null;
  return (
    <span className={cn('tabular whitespace-nowrap', className)}>
      {formatLKR(p.amount)} / {p.per}
    </span>
  );
}

/** "Best before 12 Oct" / "Expires 3 Oct", coloured by how close it is. */
export function DueText({
  dueType,
  due,
  today,
  locale,
  className,
}: {
  dueType: string;
  due: string | null | undefined;
  today: string;
  locale?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!due || dueType === 'none') return null;
  const state = dueState(dueType, due, today);
  const tone =
    state === 'expired' ? 'text-red' : state === 'bbPassed' ? 'text-caution' : state === 'dueSoon' ? 'text-due' : 'text-muted';
  const label = dueType === 'expiry' ? t('pantry.dueText.expires') : t('pantry.dueText.bestBefore');
  return (
    <span className={cn('tabular whitespace-nowrap', tone, className)}>
      {label} {formatDay(due, locale, today.slice(0, 4))}
    </span>
  );
}

/** Product photo, or a gradient tile with its initial. */
export function ProductArt({ product, photo, className }: { product: Pick<Product, 'name'>; photo?: EntityPhoto | null; className?: string }) {
  if (photo?.thumbUrl) {
    return <img src={photo.thumbUrl} alt="" loading="lazy" className={cn('h-full w-full object-cover', className)} />;
  }
  return (
    <div
      className={cn('flex h-full w-full items-center justify-center', className)}
      style={{
        background:
          'linear-gradient(145deg, color-mix(in srgb, var(--accent-a) 30%, transparent), color-mix(in srgb, var(--accent-b) 18%, transparent))',
      }}
      aria-hidden
    >
      <span className="font-display text-[22px] font-semibold text-text/90">{product.name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

/** Units grouped for a <select>: the ones a product can use, or all of them. */
export function UnitOptions({ units }: { units: Unit[] }) {
  return (
    <>
      {units.map((u) => (
        <option key={u.id} value={u.id}>
          {u.code === u.name ? u.code : `${u.code} (${u.name})`}
        </option>
      ))}
    </>
  );
}

/** Sorted list of every unit for pickers: household units first, then by dimension and size. */
export function sortedUnits(units: UnitMap | undefined): Unit[] {
  return [...(units?.values() ?? [])].sort(
    (a, b) =>
      Number(a.household_id === null) - Number(b.household_id === null) ||
      a.dimension.localeCompare(b.dimension) ||
      a.to_base - b.to_base ||
      a.code.localeCompare(b.code),
  );
}
