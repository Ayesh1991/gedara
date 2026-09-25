import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CategorySelect } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { ImageError } from '@/lib/images';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import {
  DUE_TYPES,
  addBarcode,
  createProduct,
  deleteProduct,
  invalidatePantry,
  pantryErrorKey,
  saveConversion,
  updateProduct,
  type DueTypeValue,
  type Product,
  type ProductInput,
} from '@/lib/pantry/queries';
import { parseQty, type UnitMap } from '@/lib/pantry/units';
import { removeEntityPhoto, setEntityPhoto, type EntityPhoto } from '@/lib/photos';
import type { Place } from '@/lib/places';
import type { Tree } from '@/lib/tree';
import { cn } from '@/lib/utils';
import { UnitOptions, fieldLabel, selectClass, sortedUnits } from './bits';

interface ProductFormProps {
  open: boolean;
  onClose: () => void;
  householdId: string;
  units: UnitMap;
  categories: CategoryRow[];
  products: Product[];
  tree: Tree<Place>;
  product?: Product | null;
  photo?: EntityPhoto | null;
  /** From a scan of an unknown barcode. */
  barcode?: string | null;
  /** New product from a bill line: prefilled name / category / unit. */
  initial?: { name?: string; category_id?: string | null; stock_unit_id?: string | null } | null;
  onSaved?: (p: Product | { id: string; name: string }) => void;
}

/** Create or edit a product: ≤ 5 visible fields (§5.4); the rest under "More details". */
export function ProductForm(props: ProductFormProps) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.product ? t('pantry.product.editTitle', { name: props.product.name }) : t('pantry.product.newTitle')}
    >
      <ProductFormBody {...props} />
    </Sheet>
  );
}

const numOrNull = (s: string) => (s.trim() === '' ? null : parseQty(s));
const intOrNull = (s: string) => {
  const n = numOrNull(s);
  return n === null ? null : Math.round(n);
};
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

function ProductFormBody({ onClose, householdId, units, categories, products, tree, product, photo, barcode, initial, onSaved }: ProductFormProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const g = [...units.values()].find((u) => u.household_id === null && u.code === 'g');

  const [name, setName] = useState(product?.name ?? initial?.name ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(product?.category_id ?? initial?.category_id ?? null);
  const [stockUnit, setStockUnit] = useState(product?.stock_unit_id ?? initial?.stock_unit_id ?? g?.id ?? '');
  const [placeId, setPlaceId] = useState(product?.default_location_id ?? '');
  const [dueType, setDueType] = useState<DueTypeValue>((product?.due_type as DueTypeValue) ?? 'best_before');
  const [dueDays, setDueDays] = useState(str(product?.default_due_days));
  // More details
  const [nameSi, setNameSi] = useState(product?.name_si ?? '');
  const [purchaseUnit, setPurchaseUnit] = useState(product?.purchase_unit_id ?? '');
  const [packFactor, setPackFactor] = useState('');
  const [minQty, setMinQty] = useState(str(product?.min_qty));
  const [quickQty, setQuickQty] = useState(str(product?.quick_consume_qty ?? 1));
  const [afterOpen, setAfterOpen] = useState(str(product?.due_days_after_open));
  const [frozenDays, setFrozenDays] = useState(str(product?.due_days_frozen));
  const [openedAsOut, setOpenedAsOut] = useState(product?.treat_opened_as_out ?? false);
  const [code, setCode] = useState(barcode ?? '');
  const [notes, setNotes] = useState(product?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [dropPhoto, setDropPhoto] = useState(false);
  const [touched, setTouched] = useState(Boolean(product));
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const unitList = useMemo(() => sortedUnits(units), [units]);
  const places = useMemo(
    () => [...tree.byId.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })),
    [tree],
  );
  const stockLocked = (product?.stock.lots ?? 0) > 0;
  const purchase = purchaseUnit ? units.get(purchaseUnit) : undefined;
  const stock = units.get(stockUnit);
  // A package unit (pack, bottle …) needs "1 pack = N g"; kg/g etc. convert on their own.
  const needsFactor = Boolean(
    purchase && stock && purchaseUnit !== stockUnit && (purchase.dimension === 'other' || purchase.dimension !== stock.dimension),
  );

  /** Smart defaults (§5.4): a new product copies the settings of the last one in the same category. */
  function pickCategory(id: string | null) {
    setCategoryId(id);
    if (touched || product || !id) return;
    const like = products
      .filter((p) => p.category_id === id && !p.archived)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!like) return;
    setStockUnit(like.stock_unit_id);
    setPlaceId(like.default_location_id ?? '');
    setDueType(like.due_type as DueTypeValue);
    setDueDays(str(like.default_due_days));
    setAfterOpen(str(like.due_days_after_open));
    setFrozenDays(str(like.due_days_frozen));
    setCopiedFrom(like.name);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !stockUnit || busy) return;
    const factor = needsFactor ? parseQty(packFactor) : null;
    setBusy(true);
    const input: ProductInput = {
      name: name.trim(),
      name_si: nameSi.trim() || null,
      category_id: categoryId,
      stock_unit_id: stockUnit,
      purchase_unit_id: purchaseUnit || null,
      default_location_id: placeId || null,
      due_type: dueType,
      default_due_days: dueType === 'none' ? null : intOrNull(dueDays),
      due_days_after_open: dueType === 'none' ? null : intOrNull(afterOpen),
      due_days_frozen: dueType === 'none' ? null : intOrNull(frozenDays),
      min_qty: numOrNull(minQty),
      quick_consume_qty: numOrNull(quickQty) || 1,
      treat_opened_as_out: openedAsOut,
      notes: notes.trim() || null,
    };
    try {
      const saved = product ? await updateProduct(product.id, input) : await createProduct(householdId, input);
      // Extras: a failure here shouldn't lose the product itself.
      const extras: Promise<unknown>[] = [];
      if (factor && factor > 0 && purchaseUnit) extras.push(saveConversion(householdId, saved.id, purchaseUnit, stockUnit, factor));
      if (!product && code.trim()) extras.push(addBarcode(householdId, saved.id, code, null, 1));
      if (file) extras.push(setEntityPhoto(householdId, 'product', saved.id, file, photo));
      else if (dropPhoto && photo) extras.push(removeEntityPhoto(photo));
      const results = await Promise.allSettled(extras);
      const failed = results.find((r) => r.status === 'rejected');
      await invalidatePantry(qc, householdId);
      if (failed) {
        const reason = (failed as PromiseRejectedResult).reason;
        toast.error(reason instanceof ImageError ? t(`places.photoErrors.${reason.reason}`) : t(`pantry.errors.${pantryErrorKey(reason)}`));
      }
      toast.success(t(product ? 'pantry.product.saved' : 'pantry.product.created', { name: saved.name }));
      onSaved?.(saved.id === product?.id ? { ...product, ...saved } : { id: saved.id, name: saved.name });
      onClose();
    } catch (err) {
      toast.error(t(`pantry.errors.${pantryErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!product) return;
    setBusy(true);
    try {
      await updateProduct(product.id, { archived: !product.archived });
      await invalidatePantry(qc, householdId);
      toast.success(t(product.archived ? 'pantry.product.restored' : 'pantry.product.archivedToast', { name: product.name }));
      onClose();
    } catch (err) {
      toast.error(t(`pantry.errors.${pantryErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!product) return;
    setBusy(true);
    try {
      await deleteProduct(product.id);
      if (photo) await removeEntityPhoto(photo).catch(() => undefined);
      await invalidatePantry(qc, householdId);
      toast.success(t('pantry.product.deleted', { name: product.name }));
      onClose();
      onSaved?.({ id: '', name: product.name });
    } catch (err) {
      // 23503: it has stock history → archive instead.
      toast.error(pantryErrorKey(err) === 'reference' ? t('pantry.product.hasHistory') : t(`pantry.errors.${pantryErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  const photoUrl = preview ?? (dropPhoto ? null : (photo?.thumbUrl ?? null));

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="product-name" className={fieldLabel}>
          {t('pantry.product.name')}
        </label>
        <Input
          id="product-name"
          value={name}
          maxLength={80}
          required
          autoFocus={!product}
          placeholder={t('pantry.product.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="product-category" className={fieldLabel}>
          {t('pantry.product.category')}
        </label>
        <CategorySelect id="product-category" categories={categories} value={categoryId} onChange={pickCategory} kind="expense" />
        {copiedFrom && <p className="mt-1.5 text-[12.5px] text-muted">{t('pantry.product.defaultsFrom', { name: copiedFrom })}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="product-unit" className={fieldLabel}>
            {t('pantry.product.stockUnit')}
          </label>
          <select
            id="product-unit"
            className={selectClass}
            value={stockUnit}
            disabled={stockLocked}
            onChange={(e) => {
              setStockUnit(e.target.value);
              setTouched(true);
            }}
          >
            <UnitOptions units={unitList} />
          </select>
        </div>
        <div>
          <label htmlFor="product-place" className={fieldLabel}>
            {t('pantry.product.place')}
          </label>
          <select
            id="product-place"
            className={selectClass}
            value={placeId}
            onChange={(e) => {
              setPlaceId(e.target.value);
              setTouched(true);
            }}
          >
            <option value="">{t('pantry.form.noPlace')}</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="-mt-2 text-[12.5px] text-muted">{t(stockLocked ? 'pantry.product.unitLockedHint' : 'pantry.product.stockUnitHint')}</p>

      <div>
        <span className={fieldLabel}>{t('pantry.product.dates')}</span>
        <div role="radiogroup" aria-label={t('pantry.product.dates')} className="glass grid grid-cols-3 rounded-2xl p-1">
          {DUE_TYPES.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={dueType === d}
              onClick={() => {
                setDueType(d);
                setTouched(true);
              }}
              className={cn('h-10 rounded-xl text-[13.5px] font-medium', dueType === d ? 'accent-pill text-text' : 'text-muted')}
            >
              {t(`pantry.due.${d}`)}
            </button>
          ))}
        </div>
        {dueType !== 'none' && (
          <div className="mt-2 flex items-center gap-2.5">
            <Input
              id="product-due-days"
              inputMode="numeric"
              aria-label={t('pantry.product.dueDays')}
              value={dueDays}
              onChange={(e) => {
                setDueDays(e.target.value);
                setTouched(true);
              }}
              className="tabular w-24"
            />
            <span className="text-[13.5px] text-muted">{t('pantry.product.dueDays')}</span>
          </div>
        )}
      </div>

      <details className="glass rounded-2xl px-4 py-3" open={Boolean(barcode) || undefined}>
        <summary className="cursor-pointer text-[14px] font-medium">{t('pantry.product.more')}</summary>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="product-name-si" className={fieldLabel}>
              {t('pantry.product.nameSi')}
            </label>
            <Input id="product-name-si" value={nameSi} maxLength={80} onChange={(e) => setNameSi(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="product-purchase-unit" className={fieldLabel}>
                {t('pantry.product.purchaseUnit')}
              </label>
              <select id="product-purchase-unit" className={selectClass} value={purchaseUnit} onChange={(e) => setPurchaseUnit(e.target.value)}>
                <option value="">{t('pantry.product.sameAsStock')}</option>
                <UnitOptions units={unitList} />
              </select>
            </div>
            {needsFactor && (
              <div>
                <label htmlFor="product-pack" className={fieldLabel}>
                  {t('pantry.product.packFactor', { unit: purchase?.code ?? '', stock: stock?.code ?? '' })}
                </label>
                <Input
                  id="product-pack"
                  inputMode="decimal"
                  value={packFactor}
                  placeholder={product ? t('pantry.product.packKeep') : ''}
                  onChange={(e) => setPackFactor(e.target.value)}
                  className="tabular"
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="product-min" className={fieldLabel}>
                {t('pantry.product.minQty', { unit: stock?.code ?? '' })}
              </label>
              <Input id="product-min" inputMode="decimal" value={minQty} onChange={(e) => setMinQty(e.target.value)} className="tabular" />
            </div>
            <div>
              <label htmlFor="product-quick" className={fieldLabel}>
                {t('pantry.product.quickQty', { unit: stock?.code ?? '' })}
              </label>
              <Input id="product-quick" inputMode="decimal" value={quickQty} onChange={(e) => setQuickQty(e.target.value)} className="tabular" />
            </div>
          </div>

          {dueType !== 'none' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="product-after-open" className={fieldLabel}>
                  {t('pantry.product.afterOpen')}
                </label>
                <Input id="product-after-open" inputMode="numeric" value={afterOpen} onChange={(e) => setAfterOpen(e.target.value)} className="tabular" />
              </div>
              <div>
                <label htmlFor="product-frozen" className={fieldLabel}>
                  {t('pantry.product.frozen')}
                </label>
                <Input id="product-frozen" inputMode="numeric" value={frozenDays} onChange={(e) => setFrozenDays(e.target.value)} className="tabular" />
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={openedAsOut} onChange={(e) => setOpenedAsOut(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
            {t('pantry.product.openedAsOut')}
          </label>

          {!product && (
            <div>
              <label htmlFor="product-barcode" className={fieldLabel}>
                {t('pantry.product.barcode')}
              </label>
              <Input id="product-barcode" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} className="tabular" />
            </div>
          )}

          <div>
            <label htmlFor="product-notes" className={fieldLabel}>
              {t('pantry.product.notes')}
            </label>
            <textarea
              id="product-notes"
              value={notes}
              maxLength={2000}
              rows={2}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[16px] text-text focus:border-accent-a focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-white/[0.04]">
              {photoUrl && <img src={photoUrl} alt="" className="h-full w-full object-cover" />}
            </div>
            <label className="glass inline-flex h-11 cursor-pointer items-center gap-2 rounded-[14px] px-4 text-[14px]">
              <ImagePlus className="h-4 w-4" aria-hidden />
              {t('pantry.product.photo')}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setDropPhoto(false);
                }}
              />
            </label>
            {(photo || file) && !dropPhoto && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFile(null);
                  setDropPhoto(true);
                }}
              >
                {t('places.removePhoto')}
              </Button>
            )}
          </div>
        </div>
      </details>

      <Button type="submit" variant="primary" disabled={busy || !name.trim() || !stockUnit} className="w-full">
        {busy ? t('common.saving') : t('pantry.product.save')}
      </Button>

      {product && (
        <div className="flex gap-2">
          <Button onClick={toggleArchive} disabled={busy} className="flex-1">
            {t(product.archived ? 'pantry.product.restore' : 'pantry.product.archive')}
          </Button>
          <Button variant="destructive" onClick={remove} disabled={busy} className="flex-1">
            <Trash className="h-4 w-4" aria-hidden />
            {t('pantry.product.delete')}
          </Button>
        </div>
      )}
    </form>
  );
}
