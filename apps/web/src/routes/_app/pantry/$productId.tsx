import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  CalendarPlus,
  ChevronLeft,
  ClipboardCheck,
  Copy,
  PackageOpen,
  Pencil,
  Plus,
  Printer,
  Trash2,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CodeQr } from '@/components/places/PlaceVisuals';
import { JournalList } from '@/components/pantry/JournalList';
import { ProductForm } from '@/components/pantry/ProductForm';
import { StockSheet, type StockMode } from '@/components/pantry/StockSheet';
import {
  DueText,
  ProductArt,
  Qty,
  StatusChip,
  UnitOptions,
  UnitPrice,
  fieldLabel,
  selectClass,
  sortedUnits,
  usePantry,
  useStockAction,
} from '@/components/pantry/bits';
import { Money } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { categoryLabel } from '@/lib/money/categoriesMap';
import {
  addBarcode,
  invalidatePantry,
  journalQuery,
  pantryErrorKey,
  productLotsQuery,
  removeBarcode,
  removeConversion,
  saveConversion,
  setLotDue,
  type Lot,
  type Product,
} from '@/lib/pantry/queries';
import { EXTEND_DAYS, addDays, stockStatuses } from '@/lib/pantry/status';
import { formatQty, parseQty, type UnitMap } from '@/lib/pantry/units';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/pantry/$productId')({
  component: ProductPage,
});

function IconAction({ label, onClick, icon: Icon, danger }: { label: string; onClick: () => void; icon: LucideIcon; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'glass flex h-14 min-w-[4.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11.5px] sm:h-11 sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:text-[14px]',
        danger ? 'text-red' : 'text-[#c5cce3]',
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-[19px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ProductPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { productId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const pantry = usePantry(householdId);
  const lots = useQuery(productLotsQuery(householdId, productId));
  const journal = useQuery(journalQuery(householdId, productId, 30));
  const { run } = useStockAction(householdId);
  const [sheet, setSheet] = useState<{ mode: StockMode; lot?: Lot | null } | null>(null);
  const [editing, setEditing] = useState(false);

  const product = pantry.products.data?.find((p) => p.id === productId);
  const units = pantry.units.data;
  const unit = product && units ? units.get(product.stock_unit_id) : undefined;

  if (!pantry.ready) return <div className="glass h-[420px] animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!product || !units) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="font-display text-xl font-semibold">{t('pantry.notFoundTitle')}</h1>
        <p className="text-[14px] text-muted">{t('pantry.notFoundBody')}</p>
        <Link to="/pantry" className="text-sm text-accent-b underline">
          {t('pantry.back')}
        </Link>
      </Card>
    );
  }

  const statuses = stockStatuses(
    {
      due_type: product.due_type,
      next_due: product.stock.nextDue,
      qty: product.stock.qty,
      qty_opened: product.stock.qtyOpened,
      below_min: product.stock.belowMin,
    },
    today,
  );
  const inStock = product.stock.qty > 0;
  const photo = pantry.photos.data?.get(product.id);
  const category = product.category_id ? categoryLabel(pantry.categories.data ?? [], product.category_id) : null;

  function extend(lot: Lot) {
    if (!product) return;
    const from = lot.due_date && lot.due_date > today ? lot.due_date : today;
    void run(
      () => setLotDue({ household_id: householdId, lot_id: lot.id, due_date: addDays(from, EXTEND_DAYS) }),
      () => t('pantry.done.extended', { days: EXTEND_DAYS }),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/pantry" className="-mb-2 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.pantry')}
      </Link>

      <Card className="relative overflow-hidden p-0">
        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="relative aspect-[16/9] md:aspect-auto md:min-h-[280px]">
            <ProductArt product={product} photo={photo} className="text-[40px]" />
          </div>
          <div className="flex flex-col gap-4 p-5 lg:p-6">
            <div>
              {category && <div className="text-[12.5px] text-muted">{category}</div>}
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">{product.name}</h1>
              {product.name_si && <div className="mt-0.5 text-[15px] text-[#c5cce3]">{product.name_si}</div>}
              {(statuses.length > 0 || product.archived) && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {product.archived && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted">{t('pantry.filters.archived')}</span>
                  )}
                  {statuses.map((s) => (
                    <StatusChip key={s} status={s} />
                  ))}
                </div>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[12px] text-muted">{t('pantry.product.inStock')}</dt>
                <dd className="mt-0.5 text-[20px]">
                  <Qty qty={product.stock.qty} unit={unit} />
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted">{t('pantry.product.value')}</dt>
                <dd className="mt-0.5 text-[20px]">
                  <Money value={product.stock.value} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[12px] text-muted">{t('pantry.product.price')}</dt>
                <dd className="mt-0.5 text-[15px]">
                  {product.stock.lastUnitCost !== null ? (
                    <UnitPrice unitCost={product.stock.lastUnitCost} unit={unit} />
                  ) : (
                    <span className="text-muted">{t('pantry.product.noPrice')}</span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-3">
              <CodeQr code={product.code} className="h-[64px] w-[64px] shrink-0 p-1" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-muted">{t('places.labelCode')}</div>
                <div className="tabular truncate text-[15px] text-accent-b">{product.code}</div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(product.code).then(() => toast.success(t('places.copied')));
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-text"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  {t('places.copyCode')}
                </button>
              </div>
            </div>

            {canWrite && (
              <Button variant="primary" className="mt-auto w-full" onClick={() => setSheet({ mode: 'add' })}>
                <Plus className="h-[18px] w-[18px]" aria-hidden />
                {t('pantry.actions.add')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-2 pb-1 sm:flex-wrap">
          {canWrite && inStock && <IconAction label={t('pantry.actions.use')} icon={UtensilsCrossed} onClick={() => setSheet({ mode: 'use' })} />}
          {canWrite && inStock && <IconAction label={t('pantry.actions.open')} icon={PackageOpen} onClick={() => setSheet({ mode: 'open' })} />}
          {canWrite && inStock && <IconAction label={t('pantry.actions.move')} icon={ArrowRightLeft} onClick={() => setSheet({ mode: 'move' })} />}
          {canWrite && <IconAction label={t('pantry.actions.count')} icon={ClipboardCheck} onClick={() => setSheet({ mode: 'count' })} />}
          {canWrite && <IconAction label={t('pantry.actions.edit')} icon={Pencil} onClick={() => setEditing(true)} />}
          <IconAction
            label={t('places.label')}
            icon={Printer}
            onClick={() => void navigate({ to: '/places/labels', search: { products: product.id } })}
          />
          {canWrite && inStock && (
            <IconAction label={t('pantry.actions.waste')} icon={Trash2} danger onClick={() => setSheet({ mode: 'waste' })} />
          )}
        </div>
      </div>

      <Section title={t('pantry.lots.title')} aside={<span className="tabular text-[14px] text-muted">{lots.data?.length ?? ''}</span>}>
        {lots.isPending ? (
          <div className="glass h-20 animate-pulse rounded-2xl" aria-hidden />
        ) : !lots.data?.length ? (
          <p className="text-[14px] text-[#a5b0d0]">{t('pantry.lots.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="lots">
            {lots.data.map((l) => (
              <li key={l.id} className="glass flex flex-col gap-2 rounded-2xl px-4 py-3" data-testid="lot">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Qty qty={l.qty_remaining} unit={unit} className="text-[17px]" />
                  {l.opened_at && <StatusChip status="opened" />}
                  <DueText dueType={product.due_type} due={l.due_date} today={today} locale={locale} className="text-[13px]" />
                  <UnitPrice unitCost={l.unit_cost} unit={unit} className="text-[12.5px] text-faint" />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-[12.5px] text-muted">
                  <span>{l.location_id ? pantry.tree.byId.get(l.location_id)?.path : t('pantry.form.noPlace')}</span>
                  {l.purchased_on && <span className="tabular">{t('pantry.lots.bought', { date: l.purchased_on })}</span>}
                </div>
                {canWrite && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" onClick={() => setSheet({ mode: 'use', lot: l })}>
                      {t('pantry.actions.use')}
                    </Button>
                    {!l.opened_at && (
                      <Button size="sm" onClick={() => setSheet({ mode: 'open', lot: l })}>
                        {t('pantry.actions.open')}
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setSheet({ mode: 'move', lot: l })}>
                      {t('pantry.actions.move')}
                    </Button>
                    {product.due_type !== 'none' && (
                      <>
                        <Button size="sm" onClick={() => extend(l)}>
                          <CalendarPlus className="h-4 w-4" aria-hidden />
                          {t('pantry.actions.extend', { days: EXTEND_DAYS })}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSheet({ mode: 'due', lot: l })}>
                          {t('pantry.actions.due')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <CodesSection product={product} units={units} householdId={householdId} canWrite={canWrite} />

      <Section
        title={t('pantry.journal.history')}
        aside={
          <Link to="/pantry/journal" className="text-[13.5px] text-accent-b">
            {t('pantry.journal.seeAll')}
          </Link>
        }
      >
        {journal.data ? (
          <JournalList rows={journal.data} householdId={householdId} canWrite={canWrite} showProduct={false} locale={locale} />
        ) : (
          <div className="glass h-16 animate-pulse rounded-2xl" aria-hidden />
        )}
      </Section>

      {sheet && pantry.conversions.data && (
        <StockSheet
          open
          onClose={() => setSheet(null)}
          mode={sheet.mode}
          product={product}
          lot={sheet.lot}
          householdId={householdId}
          timezone={timezone}
          units={units}
          conversions={pantry.conversions.data}
          tree={pantry.tree}
        />
      )}
      <ProductForm
        open={editing}
        onClose={() => setEditing(false)}
        householdId={householdId}
        units={units}
        categories={pantry.categories.data ?? []}
        products={pantry.products.data ?? []}
        tree={pantry.tree}
        product={product}
        photo={photo}
        onSaved={(p) => {
          if (!p.id) void navigate({ to: '/pantry' });
        }}
      />
    </div>
  );
}

/** Barcodes ("4792024000222 = 1 pack") and pack sizes ("1 pack = 400 g"). */
function CodesSection({ product, units, householdId, canWrite }: { product: Product; units: UnitMap; householdId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { barcodes, conversions } = usePantry(householdId);
  const mine = (barcodes.data ?? []).filter((b) => b.product_id === product.id);
  const packs = (conversions.data ?? []).filter((c) => c.product_id === product.id);
  const unitList = useMemo(() => sortedUnits(units), [units]);
  const stock = units.get(product.stock_unit_id);

  const [code, setCode] = useState('');
  const [codeUnit, setCodeUnit] = useState(product.purchase_unit_id ?? product.stock_unit_id);
  const [codeQty, setCodeQty] = useState('1');
  const [packUnit, setPackUnit] = useState('');
  const [packFactor, setPackFactor] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    try {
      await fn();
      await invalidatePantry(qc, householdId);
      done();
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const qty = parseQty(codeQty);
    if (!code.trim() || !qty) return;
    void act(
      () => addBarcode(householdId, product.id, code, codeUnit === product.stock_unit_id ? null : codeUnit, qty),
      () => setCode(''),
    );
  }

  function submitPack(e: FormEvent) {
    e.preventDefault();
    const f = parseQty(packFactor);
    if (!packUnit || !f) return;
    void act(
      () => saveConversion(householdId, product.id, packUnit, product.stock_unit_id, f),
      () => {
        setPackUnit('');
        setPackFactor('');
      },
    );
  }

  return (
    <Section title={t('pantry.codes.title')}>
      <Card className="flex flex-col gap-4">
        <div>
          <div className={fieldLabel}>{t('pantry.codes.barcodes')}</div>
          {mine.length === 0 ? (
            <p className="text-[13.5px] text-muted">{t('pantry.codes.noBarcodes')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {mine.map((b) => (
                <li key={b.id} className="flex items-center gap-2 text-[14px]">
                  <span className="tabular flex-1 truncate">{b.barcode}</span>
                  <span className="tabular text-muted">= {formatQty(b.qty, units.get(b.unit_id ?? product.stock_unit_id))}</span>
                  {canWrite && (
                    <button
                      type="button"
                      aria-label={t('pantry.codes.remove', { code: b.barcode })}
                      onClick={() => void act(() => removeBarcode(b.id), () => undefined)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <form onSubmit={submitCode} className="mt-2.5 grid grid-cols-[4.5rem_minmax(0,1fr)_auto] gap-1.5 sm:grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,8rem)_auto]">
              <Input
                aria-label={t('pantry.codes.barcode')}
                placeholder={t('pantry.codes.barcodePlaceholder')}
                inputMode="numeric"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="tabular col-span-3 h-11 px-3 text-[15px] sm:col-span-1"
              />
              <Input
                aria-label={t('pantry.form.qty')}
                inputMode="decimal"
                value={codeQty}
                onChange={(e) => setCodeQty(e.target.value)}
                className="tabular h-11 px-2 text-[15px]"
              />
              <select aria-label={t('pantry.form.unit')} className={cn(selectClass, 'h-11 px-2 text-[15px]')} value={codeUnit} onChange={(e) => setCodeUnit(e.target.value)}>
                <UnitOptions units={unitList} />
              </select>
              <Button type="submit" size="sm" className="h-11" disabled={busy || !code.trim()}>
                {t('pantry.codes.add')}
              </Button>
            </form>
          )}
        </div>

        <div>
          <div className={fieldLabel}>{t('pantry.codes.packs')}</div>
          {packs.length === 0 ? (
            <p className="text-[13.5px] text-muted">{t('pantry.codes.noPacks')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {packs.map((c) => (
                <li key={c.from_unit_id} className="flex items-center gap-2 text-[14px]">
                  <span className="tabular flex-1">
                    1 {units.get(c.from_unit_id)?.code} = {formatQty(c.factor, units.get(c.to_unit_id))}
                  </span>
                  {canWrite && (
                    <button
                      type="button"
                      aria-label={t('pantry.codes.removePack')}
                      onClick={() => void act(() => removeConversion(product.id, c.from_unit_id), () => undefined)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <form onSubmit={submitPack} className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[14px]">
              <span>1</span>
              <select
                aria-label={t('pantry.codes.packUnit')}
                className={cn(selectClass, 'h-11 w-auto min-w-[6rem] px-2 text-[15px]')}
                value={packUnit}
                onChange={(e) => setPackUnit(e.target.value)}
              >
                <option value="">{t('pantry.codes.pickUnit')}</option>
                <UnitOptions units={unitList.filter((u) => u.id !== product.stock_unit_id)} />
              </select>
              <span>=</span>
              <Input
                aria-label={t('pantry.codes.packFactor')}
                inputMode="decimal"
                value={packFactor}
                onChange={(e) => setPackFactor(e.target.value)}
                className="tabular h-11 w-24 px-2 text-[15px]"
              />
              <span>{stock?.code}</span>
              <Button type="submit" size="sm" className="h-11" disabled={busy || !packUnit || !parseQty(packFactor)}>
                {t('pantry.codes.add')}
              </Button>
            </form>
          )}
        </div>
      </Card>
    </Section>
  );
}
