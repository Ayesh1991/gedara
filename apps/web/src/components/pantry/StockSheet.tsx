import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { parseAmount } from '@/lib/money/format';
import {
  consume,
  inventory,
  openStock,
  productLotsQuery,
  purchase,
  setLotDue,
  transfer,
  type Lot,
  type Product,
  type StockResult,
} from '@/lib/pantry/queries';
import { EXTEND_DAYS, addDays } from '@/lib/pantry/status';
import { formatQty, parseQty, toStockQty, usableUnits, type Conversion, type UnitMap } from '@/lib/pantry/units';
import type { Place } from '@/lib/places';
import { todayIn } from '@/lib/time';
import type { Tree } from '@/lib/tree';
import { Qty, UnitOptions, UnitPrice, fieldLabel, selectClass, useStockAction } from './bits';

export type StockMode = 'add' | 'use' | 'waste' | 'open' | 'move' | 'count' | 'due';

export interface StockSheetProps {
  open: boolean;
  onClose: () => void;
  mode: StockMode;
  product: Product;
  householdId: string;
  timezone: string;
  units: UnitMap;
  conversions: Conversion[];
  tree: Tree<Place>;
  /** Act on this lot (use / open / move / due). */
  lot?: Lot | null;
  /** Start from this place (add: put it here; use / move / count: take from / count here). */
  placeId?: string | null;
  /** From a barcode: one scan means this much of this unit. */
  preset?: { unitId: string | null; qty: number } | null;
}

export function StockSheet(props: StockSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={props.open} onClose={props.onClose} title={t(`pantry.sheet.${props.mode}`, { name: props.product.name })}>
      <StockSheetBody {...props} />
    </Sheet>
  );
}

function PlaceSelect({
  id,
  tree,
  value,
  onChange,
  emptyLabel,
  required,
}: {
  id: string;
  tree: Tree<Place>;
  value: string;
  onChange: (v: string) => void;
  emptyLabel?: string;
  required?: boolean;
}) {
  const places = useMemo(
    () => [...tree.byId.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })),
    [tree],
  );
  return (
    <select id={id} className={selectClass} value={value} required={required} onChange={(e) => onChange(e.target.value)}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {places.map((p) => (
        <option key={p.id} value={p.id}>
          {p.path}
        </option>
      ))}
    </select>
  );
}

function StockSheetBody({ onClose, mode, product, householdId, timezone, units, conversions, tree, lot, placeId, preset }: StockSheetProps) {
  const { t } = useTranslation();
  const { run } = useStockAction(householdId);
  const today = todayIn(timezone);
  const stockUnit = units.get(product.stock_unit_id);
  const productConversions = useMemo(() => conversions.filter((c) => c.product_id === product.id), [conversions, product.id]);
  const choices = useMemo(
    () => usableUnits(units, product.stock_unit_id, productConversions),
    [units, product.stock_unit_id, productConversions],
  );
  const lots = useQuery(productLotsQuery(householdId, product.id));

  const purchaseUnit =
    product.purchase_unit_id && choices.some((u) => u.id === product.purchase_unit_id) ? product.purchase_unit_id : null;
  const initialUnit =
    preset?.unitId ?? (mode === 'add' || mode === 'open' ? (purchaseUnit ?? product.stock_unit_id) : product.stock_unit_id);
  const initialQty =
    mode === 'add'
      ? String(preset?.qty ?? 1)
      : mode === 'use' || mode === 'waste'
        ? String(preset?.qty ?? product.quick_consume_qty)
        : '';

  const [qtyText, setQtyText] = useState(initialQty);
  const [unitId, setUnitId] = useState<string>(initialUnit);
  // add: where it goes (the product's usual place); use / move / count: where it comes from ('' = anywhere).
  const [place, setPlace] = useState<string>(placeId ?? (mode === 'add' ? (product.default_location_id ?? '') : ''));
  const [toPlace, setToPlace] = useState<string>('');
  const [lotId, setLotId] = useState<string>(lot?.id ?? '');
  const [all, setAll] = useState(false);
  const [price, setPrice] = useState('');
  const [boughtOn, setBoughtOn] = useState(today);
  const [due, setDue] = useState<string>(() => (mode === 'due' ? (lot?.due_date ?? today) : defaultDue(product, tree, placeId ?? product.default_location_id, today)));
  const [busy, setBusy] = useState(false);

  // "Count": prefill with what Gedara thinks is there.
  const current = useMemo(() => {
    const rows = lots.data ?? [];
    return rows.filter((l) => !place || l.location_id === place).reduce((s, l) => s + l.qty_remaining, 0);
  }, [lots.data, place]);
  const [countText, setCountText] = useState<string | null>(null);
  const countValue = countText ?? (lots.isSuccess ? String(current) : '');

  const qty = parseQty(mode === 'count' ? countValue : qtyText);
  const stockQty = qty === null ? null : toStockQty(units, product.stock_unit_id, productConversions, unitId, qty);
  const totalCost = price.trim() ? parseAmount(price) : null;
  const unconvertible = qty !== null && stockQty === null;

  const unopened = (lots.data ?? []).filter((l) => !l.opened_at);
  const whole = mode === 'open' || mode === 'move' ? qtyText.trim() === '' : false;

  function valid(): boolean {
    if (unconvertible) return false;
    switch (mode) {
      case 'add':
        return stockQty !== null && stockQty > 0 && (price.trim() === '' || (totalCost !== null && totalCost >= 0));
      case 'use':
      case 'waste':
        return all || (stockQty !== null && stockQty > 0);
      case 'open':
        return whole || (stockQty !== null && stockQty > 0);
      case 'move':
        return Boolean(toPlace) && toPlace !== place && (whole || (stockQty !== null && stockQty > 0));
      case 'count':
        return stockQty !== null && stockQty >= 0;
      case 'due':
        return Boolean(lot);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !valid()) return;
    setBusy(true);
    const base = { household_id: householdId };
    const q = (r: StockResult) => formatQty(r.qty ?? stockQty ?? 0, stockUnit);
    const name = product.name;
    let action: () => Promise<StockResult>;
    let message: (r: StockResult) => string;
    switch (mode) {
      case 'add':
        action = () =>
          purchase({
            ...base,
            product_id: product.id,
            qty: qty!,
            unit_id: unitId,
            location_id: place || null,
            total_cost: totalCost,
            purchased_on: boughtOn,
            due_date: product.due_type === 'none' ? undefined : due || null,
          });
        message = (r) => t('pantry.done.added', { qty: q(r), name });
        break;
      case 'use':
      case 'waste':
        action = () =>
          consume({
            ...base,
            product_id: product.id,
            ...(all ? { all: true } : { qty: qty!, unit_id: unitId }),
            location_id: place || null,
            lot_id: lotId || null,
            reason: mode === 'waste' ? 'waste' : 'consume',
          });
        message = (r) => t(mode === 'waste' ? 'pantry.done.wasted' : 'pantry.done.used', { qty: q(r), name });
        break;
      case 'open':
        action = () =>
          openStock({
            ...base,
            ...(lotId ? { lot_id: lotId } : { product_id: product.id }),
            ...(whole ? {} : { qty: qty!, unit_id: unitId }),
          });
        message = (r) => t('pantry.done.opened', { qty: q(r), name });
        break;
      case 'move':
        action = () =>
          transfer({
            ...base,
            to_location_id: toPlace,
            ...(lotId ? { lot_id: lotId } : { product_id: product.id, from_location_id: place || null }),
            ...(whole ? {} : { qty: qty!, unit_id: unitId }),
          });
        message = (r) => t('pantry.done.moved', { qty: q(r), name, place: tree.byId.get(toPlace)?.name ?? '' });
        break;
      case 'count':
        action = () => inventory({ ...base, product_id: product.id, qty: qty!, unit_id: unitId, location_id: place || null });
        message = (r) =>
          r.correlation_id ? t('pantry.done.counted', { name, qty: formatQty(stockQty ?? 0, stockUnit) }) : t('pantry.done.countSame', { name });
        break;
      case 'due':
        action = () => setLotDue({ ...base, lot_id: lot!.id, due_date: due || null });
        message = () => t('pantry.done.dueChanged');
        break;
    }
    const r = await run(action, message, stockUnit);
    setBusy(false);
    if (r) onClose();
  }

  const qtyField = (
    <div>
      <label htmlFor="stock-qty" className={fieldLabel}>
        {mode === 'count' ? t('pantry.form.counted') : t('pantry.form.qty')}
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
        <Input
          id="stock-qty"
          inputMode="decimal"
          autoComplete="off"
          value={mode === 'count' ? countValue : qtyText}
          disabled={all}
          placeholder={mode === 'open' || mode === 'move' ? t('pantry.form.allOfIt') : undefined}
          onChange={(e) => (mode === 'count' ? setCountText(e.target.value) : setQtyText(e.target.value))}
          className="tabular"
        />
        <select aria-label={t('pantry.form.unit')} className={selectClass} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <UnitOptions units={choices} />
        </select>
      </div>
      <div className="mt-1.5 min-h-[18px] text-[12.5px] text-muted">
        {unconvertible ? (
          <span className="text-caution">{t('pantry.errors.unitMismatch')}</span>
        ) : stockQty !== null && unitId !== product.stock_unit_id && !all ? (
          <span className="tabular">= {formatQty(stockQty, stockUnit)}</span>
        ) : null}
      </div>
    </div>
  );

  const lotLabel = (l: Lot) =>
    [
      formatQty(l.qty_remaining, stockUnit),
      l.location_id ? tree.byId.get(l.location_id)?.name : null,
      l.due_date,
      l.opened_at ? t('pantry.lot.opened') : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {mode === 'due' ? (
        <div>
          <label htmlFor="stock-due" className={fieldLabel}>
            {t('pantry.form.dueDate')}
          </label>
          <div className="flex gap-2">
            <Input id="stock-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="tabular" />
            <Button onClick={() => setDue(addDays(due || today, EXTEND_DAYS))}>+{EXTEND_DAYS}</Button>
          </div>
          <button type="button" onClick={() => setDue('')} className="mt-2 text-[13px] text-muted underline">
            {t('pantry.form.noDueDate')}
          </button>
        </div>
      ) : (
        <>
          {(mode === 'use' || mode === 'waste') && (
            <label className="flex items-center gap-2.5 text-[14px]">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
              {t('pantry.form.useAll')}
            </label>
          )}
          {qtyField}

          {mode === 'add' && (
            <>
              <div>
                <label htmlFor="stock-price" className={fieldLabel}>
                  {t('pantry.form.totalPrice')}
                </label>
                <Input id="stock-price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} className="tabular" />
                {totalCost !== null && stockQty ? (
                  <div className="mt-1.5 text-[12.5px] text-muted">
                    <UnitPrice unitCost={totalCost / stockQty} unit={stockUnit} />
                  </div>
                ) : null}
              </div>
              <div>
                <label htmlFor="stock-place" className={fieldLabel}>
                  {t('pantry.form.place')}
                </label>
                <PlaceSelect
                  id="stock-place"
                  tree={tree}
                  value={place}
                  onChange={(v) => {
                    setPlace(v);
                    setDue(defaultDue(product, tree, v || null, boughtOn));
                  }}
                  emptyLabel={t('pantry.form.noPlace')}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="stock-bought" className={fieldLabel}>
                    {t('pantry.form.boughtOn')}
                  </label>
                  <Input
                    id="stock-bought"
                    type="date"
                    value={boughtOn}
                    max={today}
                    onChange={(e) => {
                      setBoughtOn(e.target.value);
                      setDue(defaultDue(product, tree, place || null, e.target.value || today));
                    }}
                    className="tabular"
                  />
                </div>
                {product.due_type !== 'none' && (
                  <div>
                    <label htmlFor="stock-due" className={fieldLabel}>
                      {t(product.due_type === 'expiry' ? 'pantry.dueText.expires' : 'pantry.dueText.bestBefore')}
                    </label>
                    <Input id="stock-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="tabular" />
                  </div>
                )}
              </div>
            </>
          )}

          {(mode === 'use' || mode === 'waste' || mode === 'count') && !lot && (
            <div>
              <label htmlFor="stock-from" className={fieldLabel}>
                {mode === 'count' ? t('pantry.form.countedAt') : t('pantry.form.fromPlace')}
              </label>
              <PlaceSelect
                id="stock-from"
                tree={tree}
                value={place}
                onChange={(v) => {
                  setPlace(v);
                  setCountText(null);
                }}
                emptyLabel={mode === 'count' ? t('pantry.form.countWhole') : t('pantry.form.anyPlace')}
              />
              {mode === 'count' && lots.isSuccess && (
                <p className="mt-1.5 text-[12.5px] text-muted">
                  {t('pantry.form.gedaraThinks')} <Qty qty={current} unit={stockUnit} />
                </p>
              )}
            </div>
          )}

          {(mode === 'open' || mode === 'move' || mode === 'use' || mode === 'waste') && (lots.data?.length ?? 0) > 1 && (
            <div>
              <label htmlFor="stock-lot" className={fieldLabel}>
                {t('pantry.form.lot')}
              </label>
              <select id="stock-lot" className={selectClass} value={lotId} onChange={(e) => setLotId(e.target.value)}>
                <option value="">{t(mode === 'open' ? 'pantry.form.firstUnopened' : 'pantry.form.fefo')}</option>
                {(mode === 'open' ? unopened : (lots.data ?? [])).map((l) => (
                  <option key={l.id} value={l.id}>
                    {lotLabel(l)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode === 'move' && (
            <>
              {!lotId && (
                <div>
                  <label htmlFor="stock-from" className={fieldLabel}>
                    {t('pantry.form.fromPlace')}
                  </label>
                  <PlaceSelect id="stock-from" tree={tree} value={place} onChange={setPlace} emptyLabel={t('pantry.form.anyPlace')} />
                </div>
              )}
              <div>
                <label htmlFor="stock-to" className={fieldLabel}>
                  {t('pantry.form.toPlace')}
                </label>
                <PlaceSelect id="stock-to" tree={tree} value={toPlace} onChange={setToPlace} emptyLabel="" required />
              </div>
            </>
          )}

          {(mode === 'use' || mode === 'waste') && <p className="text-[12.5px] text-muted">{t('pantry.form.fefoHint')}</p>}
        </>
      )}

      <Button type="submit" variant="primary" disabled={busy || !valid()} className="w-full">
        {busy ? t('common.saving') : t(`pantry.actions.${mode}`)}
      </Button>
    </form>
  );
}

/** The due date new stock gets by default (mirrors private.default_due in migration 26). */
function defaultDue(product: Product, tree: Tree<Place>, placeId: string | null, from: string): string {
  if (product.due_type === 'none') return '';
  const frozen = placeId ? tree.byId.get(placeId)?.climate === 'freezer' : false;
  if (frozen && product.due_days_frozen !== null) return addDays(from, product.due_days_frozen);
  if (product.default_due_days !== null) return addDays(from, product.default_due_days);
  return '';
}
