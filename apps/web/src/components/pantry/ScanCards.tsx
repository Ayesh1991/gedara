import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Barcode, ChevronRight, Minus, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { addBarcode, consume, invalidatePantry, pantryErrorKey } from '@/lib/pantry/queries';
import { stockStatuses } from '@/lib/pantry/status';
import { formatQty, parseQty, toStockQty, usableUnits } from '@/lib/pantry/units';
import { membershipQuery } from '@/lib/queries';
import type { Resolved } from '@/lib/resolve';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';
import { DueText, ProductArt, Qty, StatusChip, UnitOptions, fieldLabel, selectClass, usePantry, useStockAction } from './bits';
import { StockSheet } from './StockSheet';

type ProductHit = Extract<Resolved, { status: 'product' }>;

/**
 * A scanned product: what's in stock and one-tap Use / Add. On the Scan page (not compact) Add opens
 * the stock sheet; in the USB-scanner toast (compact) it links to the product instead.
 */
export function ProductScanCard({
  result,
  compact,
  onNavigate,
  className,
}: {
  result: ProductHit;
  compact?: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const membership = useQuery(membershipQuery);
  const householdId = result.product.household_id;
  const pantry = usePantry(householdId);
  const { run } = useStockAction(householdId);
  const [adding, setAdding] = useState(false);
  const timezone = membership.data?.household.timezone ?? 'Asia/Colombo';
  const locale = membership.data?.household.locale ?? 'en-LK';
  const canWrite = membership.data ? membership.data.role !== 'viewer' : false;
  const today = todayIn(timezone);

  const product = pantry.products.data?.find((p) => p.id === result.product.id);
  // A lot label (HL:LOT) was scanned: Use takes from that very pack.
  const lot = result.lot ?? null;
  const unit = product ? pantry.units.data?.get(product.stock_unit_id) : undefined;
  // One scan of a barcode means its pack (e.g. 1 pack); a Gedara label means the quick amount.
  const step = result.barcode
    ? { unitId: result.barcode.unitId ?? product?.stock_unit_id ?? null, qty: result.barcode.qty }
    : { unitId: product?.stock_unit_id ?? null, qty: product?.quick_consume_qty ?? 1 };
  const stepUnit = step.unitId ? pantry.units.data?.get(step.unitId) : undefined;
  const stepText = `${step.qty} ${stepUnit?.code ?? ''}`.trim();
  const stockStep =
    product && pantry.units.data && pantry.conversions.data
      ? toStockQty(
          pantry.units.data,
          product.stock_unit_id,
          pantry.conversions.data.filter((c) => c.product_id === product.id),
          step.unitId,
          step.qty,
        )
      : null;

  const statuses = product
    ? stockStatuses(
        {
          due_type: product.due_type,
          next_due: product.stock.nextDue,
          qty: product.stock.qty,
          qty_opened: product.stock.qtyOpened,
          below_min: product.stock.belowMin,
        },
        today,
      )
    : [];

  function use() {
    if (!product) return;
    void run(
      (label) =>
        consume(
          { household_id: householdId, product_id: product.id, qty: step.qty, unit_id: step.unitId, lot_id: lot?.id ?? undefined },
          label,
        ),
      (r) => t('pantry.done.used', { qty: formatQty(r.qty ?? stockStep ?? step.qty, unit), name: product.name }),
      unit,
    );
  }

  return (
    <div className={cn('glass-strong slide-up flex flex-col gap-3 rounded-3xl p-3.5', className)} role="status" data-testid="scan-result">
      <div className="flex items-center gap-3.5">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
          <ProductArt product={result.product} photo={pantry.photos.data?.get(result.product.id)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[18px] font-semibold">{result.product.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[13px]">
            {product && <Qty qty={product.stock.qty} unit={unit} />}
            {product && product.stock.qty > 0 && (
              <DueText dueType={product.due_type} due={product.stock.nextDue} today={today} locale={locale} className="text-[12.5px]" />
            )}
          </div>
          {lot && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted" data-testid="scan-lot">
              <span>{t('pantry.scan.thisPack')}</span>
              <Qty qty={lot.qty_remaining} unit={unit} />
              {product && <DueText dueType={product.due_type} due={lot.due_date} today={today} locale={locale} />}
            </div>
          )}
          <div className="tabular text-[11.5px] text-accent-b">{result.barcode?.code ?? lot?.code ?? result.product.code}</div>
        </div>
      </div>
      {statuses.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {statuses.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        {canWrite && product ? (
          <>
            <Button size="sm" className="h-11" disabled={product.stock.qty <= 0 || (lot !== null && lot.qty_remaining <= 0)} onClick={use}>
              <Minus className="h-4 w-4" aria-hidden />
              {t('pantry.scan.use', { qty: stepText })}
            </Button>
            {compact ? (
              <Link
                to="/pantry/$productId"
                params={{ productId: product.id }}
                onClick={onNavigate}
                className="glass flex h-11 items-center justify-center gap-1.5 rounded-[14px] text-[14px] font-semibold"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t('pantry.scan.add', { qty: stepText })}
              </Link>
            ) : (
              <Button size="sm" variant="accent" className="h-11" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('pantry.scan.add', { qty: stepText })}
              </Button>
            )}
          </>
        ) : (
          <div className="col-span-2" />
        )}
        <Link
          to="/pantry/$productId"
          params={{ productId: result.product.id }}
          onClick={onNavigate}
          aria-label={t('scan.open')}
          className="glass flex h-11 w-11 items-center justify-center rounded-[14px]"
        >
          <ChevronRight className="h-[18px] w-[18px]" aria-hidden />
        </Link>
      </div>
      {adding && product && pantry.units.data && pantry.conversions.data && (
        <StockSheet
          open
          onClose={() => setAdding(false)}
          mode="add"
          product={product}
          householdId={householdId}
          timezone={timezone}
          units={pantry.units.data}
          conversions={pantry.conversions.data}
          tree={pantry.tree}
          preset={step}
        />
      )}
    </div>
  );
}

/** A retail barcode Gedara doesn't know: make a product for it, or add it to an existing one. */
export function UnknownBarcodeCard({
  code,
  compact,
  onNavigate,
  className,
}: {
  code: string;
  compact?: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const membership = useQuery(membershipQuery);
  const [linking, setLinking] = useState(false);
  const canWrite = membership.data ? membership.data.role !== 'viewer' : false;
  return (
    <div className={cn('glass-strong slide-up flex flex-col gap-3 rounded-3xl p-4', className)} role="status" data-testid="scan-result">
      <div className="flex items-start gap-3">
        <Barcode className="mt-0.5 h-5 w-5 shrink-0 text-due" aria-hidden />
        <div className="min-w-0">
          <div className="font-display font-semibold">{t('scan.unknownBarcode.title')}</div>
          <div className="tabular mt-0.5 truncate text-[12.5px] text-muted">{code}</div>
        </div>
      </div>
      {canWrite && (
        <div className="grid grid-cols-2 gap-2">
          <Link
            to="/pantry"
            search={{ new: code }}
            onClick={onNavigate}
            className="accent-pill flex h-11 items-center justify-center gap-1.5 rounded-[14px] font-display text-[14px] font-semibold"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t('scan.unknownBarcode.create')}
          </Link>
          {compact ? (
            <Link
              to="/scan"
              onClick={onNavigate}
              className="glass flex h-11 items-center justify-center rounded-[14px] text-[14px]"
            >
              {t('scan.unknownBarcode.link')}
            </Link>
          ) : (
            <Button size="sm" className="h-11" onClick={() => setLinking(true)}>
              {t('scan.unknownBarcode.link')}
            </Button>
          )}
        </div>
      )}
      {linking && membership.data && (
        <LinkBarcodeSheet code={code} householdId={membership.data.household.id} onClose={() => setLinking(false)} />
      )}
    </div>
  );
}

function LinkBarcodeSheet({ code, householdId, onClose }: { code: string; householdId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const pantry = usePantry(householdId);
  const [productId, setProductId] = useState('');
  const [qtyText, setQtyText] = useState('1');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const products = (pantry.products.data ?? []).filter((p) => !p.archived);
  const product = products.find((p) => p.id === productId);
  const choices =
    product && pantry.units.data
      ? usableUnits(
          pantry.units.data,
          product.stock_unit_id,
          (pantry.conversions.data ?? []).filter((c) => c.product_id === product.id),
        )
      : [];
  const unit = unitId || product?.purchase_unit_id || product?.stock_unit_id || '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const qty = parseQty(qtyText);
    if (!product || !qty || busy) return;
    setBusy(true);
    try {
      await addBarcode(householdId, product.id, code, unit === product.stock_unit_id ? null : unit, qty);
      await invalidatePantry(qc, householdId);
      toast.success(t('scan.unknownBarcode.linked', { name: product.name }));
      onClose();
    } catch (err) {
      toast.error(t(`pantry.errors.${pantryErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={t('scan.unknownBarcode.linkTitle', { code })}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="link-product" className={fieldLabel}>
            {t('scan.unknownBarcode.product')}
          </label>
          <select
            id="link-product"
            required
            className={selectClass}
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setUnitId('');
            }}
          >
            <option value="" disabled>
              {t('scan.unknownBarcode.pick')}
            </option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {product && (
          <div>
            <label htmlFor="link-qty" className={fieldLabel}>
              {t('scan.unknownBarcode.oneScanIs')}
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
              <Input id="link-qty" inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="tabular" />
              <select aria-label={t('pantry.form.unit')} className={selectClass} value={unit} onChange={(e) => setUnitId(e.target.value)}>
                <UnitOptions units={choices} />
              </select>
            </div>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy || !product || !parseQty(qtyText)}>
          {t('scan.unknownBarcode.save')}
        </Button>
      </form>
    </Sheet>
  );
}
