import { useQueryClient } from '@tanstack/react-query';
import { Box, Check, CircleAlert, Package, Plus, Receipt, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CategorySelect } from '@/components/money/bits';
import { ProductForm } from '@/components/pantry/ProductForm';
import { UnitOptions, fieldLabel, selectClass } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatLKR } from '@/lib/money/format';
import { invalidatePantry, pantryErrorKey, saveConversion, type Product } from '@/lib/pantry/queries';
import { formatQty, parseQty, pricePer, usableUnits, type UnitMap } from '@/lib/pantry/units';
import { MAYBE_AT, nameScore, trigrams, type Destiny } from '@/lib/spine/match';
import { isBlocking, routeProblem, stockPreview, withProduct, type LineRoute, type StockPreview } from '@/lib/spine/route';
import { cn } from '@/lib/utils';
import type { RouterLine, SpineData } from './useSpine';

const DESTINIES: Destiny[] = ['stock', 'asset', 'expense'];
const DESTINY_ICON = { stock: Package, asset: Box, expense: Receipt } as const;

/** Route with the product's quantity defaults filled in (a product picked a moment ago may only now be loaded). */
export function effectiveRoute(route: LineRoute, line: RouterLine, products: Product[] | undefined): LineRoute {
  if (route.destiny !== 'stock' || !route.productId || route.unitId !== null) return route;
  const p = products?.find((x) => x.id === route.productId);
  return p ? withProduct(route, line, p, route.confidence) : route;
}

export function previewFor(route: LineRoute, line: RouterLine, data: SpineData): StockPreview | null {
  if (route.destiny !== 'stock' || !route.productId) return null;
  const p = data.products.data?.find((x) => x.id === route.productId);
  if (!p || !data.units.data || !data.conversions.data) return null;
  return stockPreview(route, p, data.units.data, data.conversions.data, line.amount);
}

/** "2 pack = 800 g · Rs 550.00 / kg" */
function PreviewText({ route, preview, data }: { route: LineRoute; preview: StockPreview | null; data: SpineData }) {
  const { t } = useTranslation();
  const units = data.units.data;
  const p = data.products.data?.find((x) => x.id === route.productId);
  if (!preview || !p || !units) return null;
  if ('needsPack' in preview) {
    return <span className="text-caution">{t('spine.needsPack', { unit: units.get(route.unitId ?? '')?.code ?? '' })}</span>;
  }
  if ('badQty' in preview) return <span className="text-caution">{t('spine.badQty')}</span>;
  const stock = units.get(p.stock_unit_id);
  const bought = route.unitId && route.unitId !== p.stock_unit_id ? `${formatQty(route.qty ?? 0, units.get(route.unitId))} = ` : '';
  const per = pricePer(preview.unitCost, stock);
  return (
    <span className="tabular">
      {bought}
      {formatQty(preview.stockQty, stock)}
      {per ? ` · ${formatLKR(per.amount)} / ${per.per}` : ''}
    </span>
  );
}

/**
 * The lines of one bill with where each goes. Tapping a line opens its sheet; lines without a
 * product get "New product" / "Not stock" right in the row (one thumb).
 */
export function BillRouter({
  lines,
  routes,
  onRoute,
  onCategory,
  data,
  onCreated,
}: {
  lines: RouterLine[];
  routes: Map<string, LineRoute>;
  onRoute: (key: string, route: LineRoute) => void;
  /** Import preview only: the line's category can still change. */
  onCategory?: (key: string, categoryId: string | null) => void;
  data: SpineData;
  onCreated?: (productId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<RouterLine | null>(null);
  const openLine = lines.find((l) => l.key === open) ?? null;

  return (
    <>
      <ul className="flex flex-col gap-2">
        {lines.map((l) => {
          const route = routes.get(l.key);
          if (!route) return null;
          return (
            <LineRow
              key={l.key}
              line={l}
              route={route}
              data={data}
              onOpen={() => setOpen(l.key)}
              onRoute={(r) => onRoute(l.key, r)}
              onNew={() => setCreating(l)}
            />
          );
        })}
      </ul>

      {openLine && routes.get(openLine.key) && (
        <LineRouteSheet
          line={openLine}
          route={routes.get(openLine.key)!}
          data={data}
          onClose={() => setOpen(null)}
          onRoute={(r) => onRoute(openLine.key, r)}
          onCategory={onCategory ? (id) => onCategory(openLine.key, id) : undefined}
          onNew={() => setCreating(openLine)}
        />
      )}

      {creating && data.units.data && data.categories.data && data.products.data && (
        <ProductForm
          open
          onClose={() => setCreating(null)}
          householdId={data.householdId}
          units={data.units.data}
          categories={data.categories.data}
          products={data.products.data}
          tree={data.tree}
          initial={{ name: tidyName(creating.raw_name), category_id: creating.category_id, stock_unit_id: guessStockUnit(creating, data.units.data) }}
          onSaved={(p) => {
            if (!p.id) return;
            const route = routes.get(creating.key);
            // Quantity defaults are filled in once the new product is loaded (effectiveRoute).
            if (route) onRoute(creating.key, { ...route, destiny: 'stock', productId: p.id, confidence: 'user', qty: null, unitId: null });
            onCreated?.(p.id);
          }}
        />
      )}
    </>
  );
}

/** "ANCHOR HOT CHOCOLATE" → "Anchor Hot Chocolate" (bill printers love capitals). */
export function tidyName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s !== s.toUpperCase()) return s.slice(0, 80);
  return s
    .toLowerCase()
    .replace(/(^|[\s(-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    .slice(0, 80);
}

/** kg / g / L / ml on the bill → count the new product in grams / ml; otherwise the form's default. */
function guessStockUnit(line: RouterLine, units: UnitMap): string | null {
  const u = line.unitId ? units.get(line.unitId) : undefined;
  if (!u || line.unitMissing) return null;
  const want = u.dimension === 'mass' ? 'g' : u.dimension === 'volume' ? 'ml' : u.dimension === 'count' ? 'pcs' : null;
  return [...units.values()].find((x) => x.household_id === null && x.code === want)?.id ?? null;
}

function Chip({ tone, children, onClick, label }: { tone: 'teal' | 'amber' | 'plain' | 'info'; children: ReactNode; onClick?: () => void; label?: string }) {
  const cls = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium',
    tone === 'teal' && 'bg-teal/15 text-teal',
    tone === 'amber' && 'bg-caution/15 text-caution',
    tone === 'info' && 'bg-info/15 text-info',
    tone === 'plain' && 'bg-white/[0.07] text-[#c5cce3]',
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-label={label}>
      {children}
    </button>
  ) : (
    <span className={cls}>{children}</span>
  );
}

function LineRow({
  line,
  route: raw,
  data,
  onOpen,
  onRoute,
  onNew,
}: {
  line: RouterLine;
  route: LineRoute;
  data: SpineData;
  onOpen: () => void;
  onRoute: (r: LineRoute) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const route = effectiveRoute(raw, line, data.products.data);
  const preview = previewFor(route, line, data);
  // Only a bad quantity is a problem; a line without a product just stays expense for now.
  const problem = isBlocking(routeProblem(route, preview));
  const product = data.products.data?.find((p) => p.id === route.productId);
  const Icon = DESTINY_ICON[route.destiny];
  const suggestion =
    route.destiny === 'stock' && !route.productId
      ? route.suggestions
          .filter((s) => s.score >= MAYBE_AT)
          .map((s) => data.products.data?.find((p) => p.id === s.productId && !p.archived))
          .find(Boolean)
      : undefined;
  const locked = Boolean(line.synthetic) || line.amount < 0;

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border bg-white/[0.03] p-2.5',
        problem ? 'border-caution/50' : 'border-transparent',
      )}
      data-testid="route-line"
    >
      <button type="button" onClick={onOpen} disabled={locked} className="flex items-baseline justify-between gap-3 text-left">
        <span className={cn('min-w-0 truncate text-[14px]', locked && 'text-muted italic')}>{line.raw_name}</span>
        <span className="tabular shrink-0 text-[14px]">{formatLKR(line.amount)}</span>
      </button>
      {!locked && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip
            tone={route.destiny !== 'stock' ? 'plain' : !product ? 'amber' : route.confidence === 'check' ? 'amber' : 'teal'}
            onClick={onOpen}
            label={t('spine.editLine', { name: line.raw_name })}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {t(`spine.destiny.${route.destiny}`)}
              {route.destiny === 'stock' && ` · ${product?.name ?? t('spine.needsProduct')}`}
            </span>
            {route.destiny === 'stock' && product && route.confidence !== 'check' && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            {route.destiny === 'stock' && product && route.confidence === 'check' && <span>· {t('spine.check')}</span>}
          </Chip>
          {route.destiny === 'stock' && product && (
            <span className="text-[12.5px] text-muted">
              <PreviewText route={route} preview={preview} data={data} />
            </span>
          )}
          {route.destiny === 'asset' && <span className="text-[12.5px] text-muted">{t('spine.thingsLater')}</span>}
          {route.destiny === 'stock' && !product && (
            <>
              {suggestion && (
                <Chip tone="info" onClick={() => onRoute(withProduct(route, line, suggestion))}>
                  {t('spine.suggested', { name: suggestion.name })}
                </Chip>
              )}
              <Chip tone="plain" onClick={onNew}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t('spine.newProduct')}
              </Chip>
              <Chip tone="plain" onClick={() => onRoute({ ...route, destiny: 'expense', productId: null, confidence: 'user' })}>
                {t('spine.notStock')}
              </Chip>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function LineRouteSheet({
  line,
  route: raw,
  data,
  onClose,
  onRoute,
  onCategory,
  onNew,
}: {
  line: RouterLine;
  route: LineRoute;
  data: SpineData;
  onClose: () => void;
  onRoute: (r: LineRoute) => void;
  onCategory?: (id: string | null) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const route = effectiveRoute(raw, line, data.products.data);
  const units = data.units.data;
  const product = data.products.data?.find((p) => p.id === route.productId);
  const preview = previewFor(route, line, data);
  const [picking, setPicking] = useState(!product && route.destiny === 'stock');
  // Typed text while editing; otherwise the route's quantity (which follows the product).
  const [qtyText, setQtyText] = useState<string | null>(null);
  const [pack, setPack] = useState('');
  const [busy, setBusy] = useState(false);

  const productUnits = useMemo(
    () => (product && units && data.conversions.data ? usableUnits(units, product.stock_unit_id, data.conversions.data.filter((c) => c.product_id === product.id)) : []),
    [product, units, data.conversions.data],
  );
  // The current unit stays pickable even when it can't be converted yet (so the pack size prompt shows).
  const unitChoices = useMemo(() => {
    const cur = route.unitId ? units?.get(route.unitId) : undefined;
    return cur && !productUnits.some((u) => u.id === cur.id) ? [...productUnits, cur] : productUnits;
  }, [productUnits, route.unitId, units]);
  const places = useMemo(
    () => [...data.tree.byId.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })),
    [data.tree],
  );
  const stockUnit = product ? units?.get(product.stock_unit_id) : undefined;
  const lineUnit = route.unitId ? units?.get(route.unitId) : undefined;

  async function savePack() {
    const factor = parseQty(pack);
    if (!product || !route.unitId || !factor || factor <= 0 || busy) return;
    setBusy(true);
    try {
      await saveConversion(data.householdId, product.id, route.unitId, product.stock_unit_id, factor);
      await invalidatePantry(qc, data.householdId);
      toast.success(t('spine.packSaved', { unit: lineUnit?.code ?? '', qty: formatQty(factor, stockUnit), name: product.name }));
      setPack('');
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  const dueMode = route.dueDate === undefined ? 'default' : route.dueDate === null ? 'none' : 'date';

  return (
    <Sheet open onClose={onClose} title={t('spine.editLine', { name: line.raw_name })}>
      <div className="flex items-baseline justify-between gap-3 rounded-2xl bg-white/[0.04] px-4 py-3">
        <span className="min-w-0 truncate text-[14px]">{line.raw_name}</span>
        <span className="tabular text-[15px]">{formatLKR(line.amount)}</span>
      </div>

      {onCategory && data.categories.data && (
        <div>
          <label htmlFor="route-category" className={fieldLabel}>
            {t('spine.lineCategory')}
          </label>
          <CategorySelect id="route-category" kind="expense" categories={data.categories.data} value={line.category_id} onChange={onCategory} />
        </div>
      )}

      <div>
        <span className={fieldLabel}>{t('spine.goesTo')}</span>
        <div role="radiogroup" aria-label={t('spine.goesTo')} className="glass grid grid-cols-3 rounded-2xl p-1">
          {DESTINIES.map((d) => {
            const Icon = DESTINY_ICON[d];
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={route.destiny === d}
                onClick={() => {
                  onRoute({ ...route, destiny: d, confidence: 'user', ...(d === 'stock' ? {} : { productId: null }) });
                  if (d === 'stock' && !product) setPicking(true);
                }}
                className={cn(
                  'flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-medium',
                  route.destiny === d ? 'accent-pill text-text' : 'text-muted',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(`spine.destiny.${d}`)}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[12.5px] text-muted">{t(`spine.destinyHint.${route.destiny}`)}</p>
      </div>

      {route.destiny === 'stock' && (
        <>
          {picking || !product ? (
            <ProductPicker
              line={line}
              route={route}
              data={data}
              onPick={(p) => {
                onRoute(withProduct(route, line, p));
                setQtyText(null);
                setPicking(false);
              }}
              onNew={onNew}
            />
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-line-2 px-4 py-3">
              <Package className="h-5 w-5 shrink-0 text-teal" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{product.name}</span>
              <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
                {t('spine.change')}
              </Button>
            </div>
          )}

          {product && !picking && units && (
            <>
              <div>
                <label htmlFor="route-qty" className={fieldLabel}>
                  {t('spine.qty')}
                </label>
                <div className="grid grid-cols-[1fr_1.2fr] gap-2">
                  <Input
                    id="route-qty"
                    inputMode="decimal"
                    className="tabular"
                    value={qtyText ?? (route.qty != null ? String(route.qty) : '')}
                    onChange={(e) => {
                      setQtyText(e.target.value);
                      onRoute({ ...route, qty: parseQty(e.target.value), confidence: route.confidence === 'check' ? 'user' : route.confidence });
                    }}
                  />
                  <select
                    aria-label={t('spine.unit')}
                    className={selectClass}
                    value={route.unitId ?? ''}
                    onChange={(e) => onRoute({ ...route, unitId: e.target.value })}
                  >
                    <UnitOptions units={unitChoices} />
                  </select>
                </div>
                <p className="mt-1.5 text-[13px] text-muted">
                  <PreviewText route={route} preview={preview} data={data} />
                </p>
              </div>

              {preview && 'needsPack' in preview && lineUnit && stockUnit && (
                <div className="flex flex-col gap-2 rounded-2xl border border-caution/40 bg-caution/10 p-3">
                  <label htmlFor="route-pack" className="text-[13.5px]">
                    {t('spine.packHint', { unit: lineUnit.code, name: product.name, stock: stockUnit.code })}
                  </label>
                  <div className="flex gap-2">
                    <Input id="route-pack" inputMode="decimal" className="tabular" value={pack} onChange={(e) => setPack(e.target.value)} />
                    <Button disabled={busy || !parseQty(pack)} onClick={() => void savePack()}>
                      {t('spine.packSave')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="route-place" className={fieldLabel}>
                    {t('spine.place')}
                  </label>
                  <select
                    id="route-place"
                    className={selectClass}
                    value={route.locationId === undefined ? '__default' : (route.locationId ?? '')}
                    onChange={(e) =>
                      onRoute({ ...route, locationId: e.target.value === '__default' ? undefined : e.target.value || null })
                    }
                  >
                    <option value="__default">{t('spine.usualPlace')}</option>
                    <option value="">{t('pantry.form.noPlace')}</option>
                    {places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.path}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="route-due" className={fieldLabel}>
                    {t('spine.due')}
                  </label>
                  <select
                    id="route-due"
                    className={selectClass}
                    value={dueMode}
                    onChange={(e) =>
                      onRoute({
                        ...route,
                        dueDate: e.target.value === 'default' ? undefined : e.target.value === 'none' ? null : (route.dueDate ?? ''),
                      })
                    }
                  >
                    <option value="default">{t('spine.dueDefault')}</option>
                    <option value="none">{t('spine.dueNone')}</option>
                    <option value="date">{t('spine.dueDate')}</option>
                  </select>
                </div>
              </div>
              {dueMode === 'date' && (
                <Input
                  type="date"
                  aria-label={t('spine.dueDate')}
                  value={route.dueDate ?? ''}
                  onChange={(e) => onRoute({ ...route, dueDate: e.target.value || '' })}
                />
              )}
            </>
          )}
        </>
      )}

      <Button variant="primary" className="w-full" onClick={onClose}>
        {t('spine.done')}
      </Button>
    </Sheet>
  );
}

function ProductPicker({
  line,
  route,
  data,
  onPick,
  onNew,
}: {
  line: RouterLine;
  route: LineRoute;
  data: SpineData;
  onPick: (p: Product) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const active = useMemo(() => (data.products.data ?? []).filter((p) => !p.archived), [data.products.data]);
  const shown = useMemo(() => {
    const query = q.trim();
    if (!query) {
      const suggested = route.suggestions.map((s) => active.find((p) => p.id === s.productId)).filter((p): p is Product => Boolean(p));
      const rest = active.filter((p) => !suggested.includes(p));
      return [...suggested, ...rest].slice(0, 30);
    }
    const tg = trigrams(query);
    const lower = query.toLowerCase();
    return active
      .map((p) => ({
        p,
        s: Math.max(
          nameScore([trigrams(p.name), ...(p.name_si ? [trigrams(p.name_si)] : [])], tg),
          p.name.toLowerCase().includes(lower) || (p.name_si ?? '').includes(query) ? 1 : 0,
        ),
      }))
      .filter((x) => x.s >= 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.p);
  }, [q, active, route.suggestions]);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="route-product-search" className={fieldLabel}>
        {t('spine.pickProduct')}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          id="route-product-search"
          className="pl-10"
          placeholder={t('spine.searchProducts')}
          value={q}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label={t('spine.pickProduct')}>
        {shown.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className={cn(
                'flex h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[14.5px] hover:bg-white/[0.06]',
                p.id === route.productId && 'accent-pill',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {route.suggestions.some((s) => s.productId === p.id) && !q && (
                <span className="text-[11.5px] text-info">{t('spine.similar')}</span>
              )}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-2 text-[13.5px] text-muted">{t('spine.noProducts')}</li>}
      </ul>
      <Button onClick={onNew}>
        <Plus className="h-4 w-4" aria-hidden />
        {t('spine.newProductNamed', { name: tidyName(line.raw_name) })}
      </Button>
      {route.destiny === 'stock' && !route.productId && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-caution">
          <CircleAlert className="h-3.5 w-3.5" aria-hidden />
          {t('spine.needsProductHint')}
        </p>
      )}
    </div>
  );
}
