import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus, Receipt } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CategorySelect, Money } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { ImageError } from '@/lib/images';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { parseAmount } from '@/lib/money/format';
import { removeEntityPhoto, setEntityPhoto, type EntityPhoto } from '@/lib/photos';
import type { Place } from '@/lib/places';
import { cleanCustom, fieldsFor, formValue, type CategoryField } from '@/lib/things/fields';
import {
  CONDITIONS,
  MANUAL_STATUSES,
  createAsset,
  createTag,
  invalidateThings,
  setAssetTags,
  thingsErrorKey,
  updateAsset,
  type Asset,
  type AssetInput,
  type PendingLine,
  type Tag,
} from '@/lib/things/queries';
import { assetTag, suggestedLifeMonths } from '@/lib/things/value';
import { formatDay } from '@/lib/time';
import type { Tree } from '@/lib/tree';
import { cn } from '@/lib/utils';
import { fieldLabel, selectClass, textareaClass } from './bits';

/** Prefill for a thing entered from a bill line ("bought, not entered yet"). */
export interface AssetInitial {
  name?: string;
  category_id?: string | null;
  location_id?: string | null;
  parent_id?: string | null;
  transaction_line_id?: string | null;
  purchase_price?: number | null;
  purchased_on?: string | null;
  vendor?: string | null;
  quantity?: number;
  /** Shown as "From the bill: …". */
  bill?: { payee: string | null; date: string | null; amount: number } | null;
  // From a scanned warranty card / rating plate (Phase 7). With an existing thing they only fill
  // fields that are still empty.
  warranty_until?: string | null;
  lifetime_warranty?: boolean;
  maker?: string | null;
  model?: string | null;
  serial?: string | null;
  description?: string | null;
}

/** A bill line → the asset form's prefill: its name, category, price and the bill's date and shop. */
export function initialFromLine(
  l: Pick<PendingLine, 'line_id' | 'raw_name' | 'category_id' | 'qty' | 'amount' | 'occurred_on' | 'payee_text'>,
): AssetInitial {
  const qty = Number(l.qty ?? 1);
  const whole = Number.isInteger(qty) && qty > 1 && qty <= 100 ? qty : 1;
  return {
    name: (l.raw_name ?? '').slice(0, 80),
    category_id: l.category_id,
    transaction_line_id: l.line_id,
    purchase_price: l.amount === null ? null : Number(l.amount),
    purchased_on: l.occurred_on,
    vendor: l.payee_text,
    quantity: whole,
    bill: { payee: l.payee_text, date: l.occurred_on, amount: Number(l.amount ?? 0) },
  };
}

interface AssetFormProps {
  open: boolean;
  onClose: () => void;
  householdId: string;
  locale: string;
  categories: CategoryRow[];
  tree: Tree<Place>;
  assets: Asset[];
  tags: Tag[];
  fields: CategoryField[];
  asset?: Asset | null;
  photo?: EntityPhoto | null;
  initial?: AssetInitial | null;
  onSaved?: (id: string) => void;
}

export function AssetForm(props: AssetFormProps) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.asset ? t('things.form.editTitle', { name: props.asset.name }) : t('things.form.newTitle')}
    >
      {props.open && <AssetFormBody {...props} />}
    </Sheet>
  );
}

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const intOrNull = (s: string) => {
  const n = Number(s.trim());
  return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n);
};

/** Descendants of a thing (it can't become a part of them). */
function partIds(assets: Asset[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of assets) {
      if (a.parent_id && out.has(a.parent_id) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

function AssetFormBody({
  onClose,
  householdId,
  locale,
  categories,
  tree,
  assets,
  tags,
  fields,
  asset,
  photo,
  initial,
  onSaved,
}: AssetFormProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const src = asset ?? null;

  const [name, setName] = useState(src?.name ?? initial?.name ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(src?.category_id ?? initial?.category_id ?? null);
  const [placeId, setPlaceId] = useState(src?.location_id ?? initial?.location_id ?? '');
  const [price, setPrice] = useState(str(src?.purchase_price ?? initial?.purchase_price));
  const [boughtOn, setBoughtOn] = useState(src?.purchased_on ?? initial?.purchased_on ?? '');
  const [warranty, setWarranty] = useState(src?.warranty_until ?? initial?.warranty_until ?? '');
  // More details
  const [quantity, setQuantity] = useState(str(src?.quantity ?? initial?.quantity ?? 1));
  const [maker, setMaker] = useState(src?.manufacturer || initial?.maker || '');
  const [model, setModel] = useState(src?.model_no || initial?.model || '');
  const [serial, setSerial] = useState(src?.serial_no || initial?.serial || '');
  const [condition, setCondition] = useState(src?.condition ?? '');
  const [status, setStatus] = useState(src?.status ?? 'in_use');
  const [vendor, setVendor] = useState(src?.vendor || initial?.vendor || '');
  const [life, setLife] = useState(str(src?.useful_life_months));
  const [salvage, setSalvage] = useState(str(src?.salvage_value));
  const [lifetime, setLifetime] = useState(src?.lifetime_warranty || initial?.lifetime_warranty || false);
  const [warrantyNotes, setWarrantyNotes] = useState(src?.warranty_notes ?? '');
  const [insured, setInsured] = useState(src?.insured ?? false);
  const [insuranceNotes, setInsuranceNotes] = useState(src?.insurance_notes ?? '');
  const [parentId, setParentId] = useState(src?.parent_id ?? initial?.parent_id ?? '');
  const [tagIds, setTagIds] = useState<string[]>(src?.tag_ids ?? []);
  const [newTag, setNewTag] = useState('');
  const [description, setDescription] = useState(src?.description || initial?.description || '');
  const previousCustom = (src?.custom ?? {}) as Record<string, unknown>;
  const [custom, setCustom] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(Object.entries(previousCustom).map(([k, v]) => [k, formValue(v)])),
  );
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [dropPhoto, setDropPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const places = useMemo(
    () => [...tree.byId.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })),
    [tree],
  );
  const parents = useMemo(() => {
    const blocked = src ? partIds(assets, src.id) : new Set<string>();
    return assets
      .filter((a) => !blocked.has(a.id) && !['sold', 'disposed', 'lost'].includes(a.status))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assets, src]);
  const templates = useMemo(() => fieldsFor(fields, categoryId, categories), [fields, categoryId, categories]);
  const category = categories.find((c) => c.id === categoryId);
  const lifeHint = suggestedLifeMonths(category?.name);
  const lineId = src?.transaction_line_id ?? initial?.transaction_line_id ?? null;
  const statusLocked = src?.status === 'sold' || src?.status === 'lent';

  async function addTag() {
    const n = newTag.trim();
    if (!n) return;
    const existing = tags.find((x) => x.name.toLowerCase() === n.toLowerCase());
    try {
      const tag = existing ?? (await createTag(householdId, n));
      setTagIds((ids) => (ids.includes(tag.id) ? ids : [...ids, tag.id]));
      setNewTag('');
      if (!existing) await invalidateThings(qc, householdId);
    } catch (e) {
      toast.error(t(`things.errors.${thingsErrorKey(e)}`));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const cleaned = cleanCustom(templates, custom, previousCustom);
    setCustomErrors(cleaned.errors);
    if (Object.keys(cleaned.errors).length) return;
    const priceValue = price.trim() ? parseAmount(price) : null;
    const salvageValue = salvage.trim() ? parseAmount(salvage) : null;
    if ((price.trim() && priceValue === null) || (salvage.trim() && salvageValue === null)) {
      toast.error(t('things.errors.invalid'));
      return;
    }
    setBusy(true);
    const input: AssetInput = {
      name: name.trim(),
      category_id: categoryId,
      location_id: placeId || null,
      purchase_price: priceValue,
      purchased_on: boughtOn || null,
      warranty_until: lifetime ? null : warranty || null,
      quantity: Math.max(1, intOrNull(quantity) ?? 1),
      manufacturer: maker.trim() || null,
      model_no: model.trim() || null,
      serial_no: serial.trim() || null,
      condition: condition || null,
      vendor: vendor.trim() || null,
      useful_life_months: intOrNull(life),
      salvage_value: salvageValue,
      lifetime_warranty: lifetime,
      warranty_notes: warrantyNotes.trim() || null,
      insured,
      insurance_notes: insured ? insuranceNotes.trim() || null : null,
      parent_id: parentId || null,
      description: description.trim() || null,
      custom: cleaned.value,
      ...(statusLocked ? {} : { status }),
      ...(src ? {} : { transaction_line_id: lineId }),
    };
    try {
      const saved = src ? await updateAsset(src.id, input) : await createAsset(householdId, input);
      // Extras: a failure here shouldn't lose the thing itself.
      const extras: Promise<unknown>[] = [setAssetTags(householdId, saved.id, tagIds, src?.tag_ids ?? [])];
      if (file) extras.push(setEntityPhoto(householdId, 'asset', saved.id, file, photo));
      else if (dropPhoto && photo) extras.push(removeEntityPhoto(photo));
      const results = await Promise.allSettled(extras);
      const failed = results.find((r) => r.status === 'rejected');
      await invalidateThings(qc, householdId);
      if (failed) {
        const reason = (failed as PromiseRejectedResult).reason;
        toast.error(reason instanceof ImageError ? t(`places.photoErrors.${reason.reason}`) : t(`things.errors.${thingsErrorKey(reason)}`));
      }
      toast.success(t(src ? 'things.form.saved' : 'things.form.created', { name: saved.name, tag: assetTag(saved.asset_no) }));
      onSaved?.(saved.id);
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  const photoUrl = preview ?? (dropPhoto ? null : (photo?.thumbUrl ?? null));

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="asset-form">
      {initial?.bill && (
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[13.5px]">
          <Receipt className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {t('things.form.fromBill', {
              shop: initial.bill.payee ?? t('things.form.aShop'),
              date: initial.bill.date ? formatDay(initial.bill.date, locale) : '',
            })}
          </span>
          <Money value={initial.bill.amount} className="text-[13.5px]" />
        </div>
      )}

      <div className="flex items-end gap-3">
        <label className="relative h-[72px] w-[72px] shrink-0 cursor-pointer overflow-hidden rounded-2xl bg-white/[0.04]">
          {photoUrl ? (
            <img src={photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[11px] text-muted">
              <ImagePlus className="h-5 w-5" aria-hidden />
              {t('things.form.photo')}
            </span>
          )}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label={t('things.form.photo')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setDropPhoto(false);
            }}
          />
        </label>
        <div className="min-w-0 flex-1">
          <label htmlFor="asset-name" className={fieldLabel}>
            {t('things.form.name')}
          </label>
          <Input
            id="asset-name"
            value={name}
            maxLength={80}
            required
            autoFocus={!src}
            placeholder={t('things.form.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      {(photo || file) && !dropPhoto && (
        <button
          type="button"
          className="-mt-2 self-start text-[12.5px] text-muted underline"
          onClick={() => {
            setFile(null);
            setDropPhoto(true);
          }}
        >
          {t('places.removePhoto')}
        </button>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="asset-category" className={fieldLabel}>
            {t('things.form.category')}
          </label>
          <CategorySelect id="asset-category" categories={categories} value={categoryId} onChange={setCategoryId} kind="expense" />
        </div>
        <div>
          <label htmlFor="asset-place" className={fieldLabel}>
            {t('things.form.place')}
          </label>
          <select id="asset-place" className={selectClass} value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
            <option value="">{t('things.noPlace')}</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="asset-price" className={fieldLabel}>
            {t('things.form.price')}
          </label>
          <Input id="asset-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="tabular" />
        </div>
        <div>
          <label htmlFor="asset-bought" className={fieldLabel}>
            {t('things.form.boughtOn')}
          </label>
          <Input id="asset-bought" type="date" value={boughtOn} onChange={(e) => setBoughtOn(e.target.value)} className="tabular" />
        </div>
      </div>

      <div>
        <label htmlFor="asset-warranty" className={fieldLabel}>
          {t('things.form.warrantyUntil')}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="asset-warranty"
            type="date"
            value={lifetime ? '' : warranty}
            disabled={lifetime}
            onChange={(e) => setWarranty(e.target.value)}
            className="tabular w-auto min-w-[11rem] flex-1"
          />
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={lifetime} onChange={(e) => setLifetime(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
            {t('things.form.lifetime')}
          </label>
        </div>
      </div>

      <details className="glass rounded-2xl px-4 py-3" open={Boolean(initial?.maker || initial?.model || initial?.serial) || undefined}>
        <summary className="cursor-pointer text-[14px] font-medium">{t('things.form.more')}</summary>
        <div className="mt-4 flex flex-col gap-4">
          {templates.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {templates.map((f) => (
                <CustomField
                  key={f.key}
                  field={f}
                  value={custom[f.key]}
                  error={customErrors[f.key]}
                  onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="asset-maker" className={fieldLabel}>
                {t('things.form.maker')}
              </label>
              <Input id="asset-maker" value={maker} maxLength={80} onChange={(e) => setMaker(e.target.value)} />
            </div>
            <div>
              <label htmlFor="asset-model" className={fieldLabel}>
                {t('things.form.model')}
              </label>
              <Input id="asset-model" value={model} maxLength={80} onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <div>
              <label htmlFor="asset-serial" className={fieldLabel}>
                {t('things.form.serial')}
              </label>
              <Input id="asset-serial" value={serial} maxLength={120} autoComplete="off" onChange={(e) => setSerial(e.target.value)} className="tabular" />
            </div>
            <div>
              <label htmlFor="asset-qty" className={fieldLabel}>
                {t('things.form.quantity')}
              </label>
              <Input id="asset-qty" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="tabular" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="asset-condition" className={fieldLabel}>
                {t('things.form.condition')}
              </label>
              <select id="asset-condition" className={selectClass} value={condition} onChange={(e) => setCondition(e.target.value)}>
                <option value="">—</option>
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {t(`things.condition.${c}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="asset-status" className={fieldLabel}>
                {t('things.form.status')}
              </label>
              <select
                id="asset-status"
                className={selectClass}
                value={status}
                disabled={statusLocked}
                onChange={(e) => setStatus(e.target.value)}
              >
                {(statusLocked ? [status] : MANUAL_STATUSES).map((s) => (
                  <option key={s} value={s}>
                    {t(`things.status.${s as (typeof MANUAL_STATUSES)[number]}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="asset-vendor" className={fieldLabel}>
              {t('things.form.vendor')}
            </label>
            <Input id="asset-vendor" value={vendor} maxLength={120} onChange={(e) => setVendor(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="asset-life" className={fieldLabel}>
                {t('things.form.life')}
              </label>
              <Input
                id="asset-life"
                inputMode="numeric"
                value={life}
                placeholder={lifeHint ? String(lifeHint) : ''}
                onChange={(e) => setLife(e.target.value)}
                className="tabular"
              />
            </div>
            <div>
              <label htmlFor="asset-salvage" className={fieldLabel}>
                {t('things.form.salvage')}
              </label>
              <Input id="asset-salvage" inputMode="decimal" value={salvage} onChange={(e) => setSalvage(e.target.value)} className="tabular" />
            </div>
          </div>
          {lifeHint && !life && (
            <button type="button" className="-mt-2 self-start text-[12.5px] text-accent-b" onClick={() => setLife(String(lifeHint))}>
              {t('things.form.lifeHint', { months: lifeHint })}
            </button>
          )}

          <div>
            <label htmlFor="asset-warranty-notes" className={fieldLabel}>
              {t('things.form.warrantyNotes')}
            </label>
            <Input id="asset-warranty-notes" value={warrantyNotes} maxLength={500} onChange={(e) => setWarrantyNotes(e.target.value)} />
          </div>

          <label className="flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={insured} onChange={(e) => setInsured(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
            {t('things.form.insured')}
          </label>
          {insured && (
            <Input
              aria-label={t('things.form.insuranceNotes')}
              placeholder={t('things.form.insuranceNotes')}
              value={insuranceNotes}
              maxLength={500}
              onChange={(e) => setInsuranceNotes(e.target.value)}
            />
          )}

          <div>
            <label htmlFor="asset-parent" className={fieldLabel}>
              {t('things.form.partOf')}
            </label>
            <select id="asset-parent" className={selectClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t('things.form.notAPart')}</option>
              {parents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {assetTag(a.asset_no)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={fieldLabel}>{t('things.form.tags')}</span>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const on = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTagIds((ids) => (on ? ids.filter((x) => x !== tag.id) : [...ids, tag.id]))}
                    className={cn('h-9 rounded-full px-3.5 text-[13.5px]', on ? 'accent-pill text-text' : 'glass text-muted')}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex gap-1.5">
              <Input
                aria-label={t('things.form.newTag')}
                placeholder={t('things.form.newTag')}
                value={newTag}
                maxLength={40}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addTag();
                  }
                }}
                className="h-11"
              />
              <Button size="sm" className="h-11" onClick={() => void addTag()} disabled={!newTag.trim()}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('things.form.addTag')}
              </Button>
            </div>
          </div>

          <div>
            <label htmlFor="asset-description" className={fieldLabel}>
              {t('things.form.description')}
            </label>
            <textarea
              id="asset-description"
              value={description}
              maxLength={2000}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
              className={textareaClass}
            />
          </div>
        </div>
      </details>

      <Button type="submit" variant="primary" disabled={busy || !name.trim()} className="w-full">
        {busy ? t('common.saving') : t('things.form.save')}
      </Button>
    </form>
  );
}

function CustomField({
  field,
  value,
  error,
  onChange,
}: {
  field: CategoryField;
  value: string | boolean | undefined;
  error?: string;
  onChange: (v: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const id = `asset-field-${field.key}`;
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2.5 self-end pb-3 text-[14px]">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
        {field.label}
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <div>
      <label htmlFor={id} className={fieldLabel}>
        {field.label}
      </label>
      {field.type === 'select' ? (
        <select id={id} className={selectClass} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type={field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}
          inputMode={field.type === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={cn(field.type !== 'text' && 'tabular')}
        />
      )}
      {error && <p className="mt-1 text-[12.5px] text-red">{t(`things.fieldErrors.${error as 'number' | 'date' | 'url' | 'option'}`)}</p>}
    </div>
  );
}
