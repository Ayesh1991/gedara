import { useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Check, ChevronLeft, ListChecks, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UnitOptions, fieldLabel, selectClass, sortedUnits, usePantry } from '@/components/pantry/bits';
import { useShoppingList } from '@/components/spine/useShopping';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatLKR } from '@/lib/money/format';
import { pantryErrorKey } from '@/lib/pantry/queries';
import { formatQty, parseQty, pricePer, usableUnits, type UnitMap } from '@/lib/pantry/units';
import {
  addListItem,
  clearDone,
  deleteListItem,
  invalidateShopping,
  updateListItem,
  type ListItem,
} from '@/lib/spine/queries';
import { itemName, splitList } from '@/lib/spine/shopping';
import { formatDay, todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/pantry/list')({
  component: ShoppingListPage,
});

function ShoppingListPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const list = useShoppingList(householdId, canWrite, true);
  const pantry = usePantry(householdId);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<ListItem | null>(null);
  const [busy, setBusy] = useState(false);

  const { open, done } = useMemo(() => splitList(list.data ?? []), [list.data]);
  const products = useMemo(() => (pantry.products.data ?? []).filter((p) => !p.archived), [pantry.products.data]);
  const refresh = () => invalidateShopping(qc, householdId);
  const fail = (e: unknown) => toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = text.trim();
    if (!name || busy) return;
    // A product name (or Sinhala name) adds the product; anything else is a free-text item.
    const lower = name.toLowerCase();
    const product = products.find((p) => p.name.toLowerCase() === lower || (p.name_si ?? '') === name);
    setBusy(true);
    try {
      await addListItem(householdId, product ? { productId: product.id } : { freeText: name }, open);
      setText('');
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function tick(item: ListItem, value: boolean) {
    try {
      await updateListItem(item.id!, { done: value });
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function clear() {
    try {
      await clearDone(householdId);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/pantry" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.pantry')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('shopping.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('shopping.intro')}</p>
      </div>

      {canWrite && (
        <form onSubmit={add} className="flex gap-2">
          <Input
            aria-label={t('shopping.add')}
            placeholder={t('shopping.addPlaceholder')}
            list="shopping-products"
            autoComplete="off"
            maxLength={120}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <datalist id="shopping-products">
            {products.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()} aria-label={t('shopping.add')}>
            <Plus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{t('shopping.add')}</span>
          </Button>
        </form>
      )}

      {list.isError ? (
        <Card className="text-[14px] text-red">{t('shopping.loadError')}</Card>
      ) : list.isPending ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : open.length === 0 && done.length === 0 ? (
        <Card className="flex flex-col items-start gap-3">
          <div className="brand-gradient flex h-12 w-12 items-center justify-center rounded-2xl text-[#05070F]">
            <ListChecks className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="font-display text-[20px] font-semibold">{t('shopping.emptyTitle')}</h2>
          <p className="max-w-prose text-[14.5px] leading-relaxed text-[#a5b0d0]">{t('shopping.emptyBody')}</p>
        </Card>
      ) : (
        <>
          <Card className="p-0">
            <h2 className="px-5 pt-4 pb-2 font-display text-[17px] font-semibold">
              {t('shopping.toBuy', { count: open.length })}
            </h2>
            {open.length === 0 ? (
              <p className="px-5 pb-4 text-[14px] text-muted">{t('shopping.allBought')}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="shopping-open">
                {open.map((i) => (
                  <ItemRow
                    key={i.id}
                    item={i}
                    units={pantry.units.data}
                    canWrite={canWrite}
                    onTick={() => void tick(i, true)}
                    onOpen={() => setEditing(i)}
                  />
                ))}
              </ul>
            )}
          </Card>

          {done.length > 0 && (
            <Card className="p-0">
              <div className="flex items-center gap-3 px-5 pt-4 pb-2">
                <h2 className="flex-1 font-display text-[17px] font-semibold">{t('shopping.bought', { count: done.length })}</h2>
                {canWrite && (
                  <Button size="sm" variant="ghost" onClick={() => void clear()}>
                    {t('shopping.clearDone')}
                  </Button>
                )}
              </div>
              <ul className="divide-y divide-line" data-testid="shopping-done">
                {done.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-5 py-3">
                    <button
                      type="button"
                      disabled={!canWrite}
                      onClick={() => void tick(i, false)}
                      aria-label={t('shopping.untick', { name: itemName(i) })}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal/20 text-teal"
                    >
                      <Check className="h-5 w-5" aria-hidden />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-muted line-through">{itemName(i)}</div>
                      {i.bought_on && i.bought_transaction_id && (
                        <Link
                          to="/money/tx/$txId"
                          params={{ txId: i.bought_transaction_id }}
                          className="text-[12.5px] text-accent-b hover:underline"
                        >
                          {t('shopping.boughtAt', { shop: i.bought_at ?? '', date: formatDay(i.bought_on, locale, today.slice(0, 4)) })}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {editing && (
        <ItemSheet
          item={editing}
          units={pantry.units.data}
          conversions={pantry.conversions.data ?? []}
          canWrite={canWrite}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function ItemRow({
  item,
  units,
  canWrite,
  onTick,
  onOpen,
}: {
  item: ListItem;
  units: UnitMap | undefined;
  canWrite: boolean;
  onTick: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const unit = item.unit_id ? units?.get(item.unit_id) : undefined;
  const stockUnit = item.stock_unit_id ? units?.get(item.stock_unit_id) : undefined;
  const best = item.best_unit_cost != null ? pricePer(item.best_unit_cost, stockUnit) : null;
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <button
        type="button"
        disabled={!canWrite}
        onClick={onTick}
        aria-label={t('shopping.tick', { name: itemName(item) })}
        className="h-9 w-9 shrink-0 rounded-xl border-2 border-line-2 hover:border-teal"
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px]">{itemName(item)}</span>
          {item.source === 'below_min' && (
            <span className="rounded-full bg-due/15 px-2 py-0.5 text-[10.5px] font-medium text-due">{t('shopping.low')}</span>
          )}
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {[
            item.qty != null ? formatQty(item.qty, unit) : null,
            item.product_id && item.stock_qty != null ? t('shopping.have', { qty: formatQty(item.stock_qty, stockUnit) }) : null,
            best && item.best_merchant ? t('shopping.cheapest', { shop: item.best_merchant, price: `${formatLKR(best.amount)} / ${best.per}` }) : null,
            item.note,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </button>
    </li>
  );
}

function ItemSheet({
  item,
  units,
  conversions,
  canWrite,
  onClose,
  onChanged,
}: {
  item: ListItem;
  units: UnitMap | undefined;
  conversions: Array<{ product_id: string; from_unit_id: string; to_unit_id: string; factor: number }>;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [qty, setQty] = useState(item.qty != null ? String(item.qty) : '');
  const [unitId, setUnitId] = useState(item.unit_id ?? item.stock_unit_id ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => {
    if (!units) return [];
    if (item.stock_unit_id) return usableUnits(units, item.stock_unit_id, conversions.filter((c) => c.product_id === item.product_id));
    return sortedUnits(units);
  }, [units, item.stock_unit_id, item.product_id, conversions]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={itemName(item)}>
      {item.source === 'below_min' && (
        <p className="text-[13.5px] text-muted">{t('shopping.autoHint', { min: formatQty(item.min_qty ?? 0, item.stock_unit_id ? units?.get(item.stock_unit_id) : undefined) })}</p>
      )}
      <div className="grid grid-cols-[1fr_1.2fr] gap-2">
        <div>
          <label htmlFor="item-qty" className={fieldLabel}>
            {t('shopping.qty')}
          </label>
          <Input id="item-qty" inputMode="decimal" className="tabular" value={qty} onChange={(e) => setQty(e.target.value)} disabled={!canWrite} />
        </div>
        <div>
          <label htmlFor="item-unit" className={fieldLabel}>
            {t('spine.unit')}
          </label>
          <select id="item-unit" className={selectClass} value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!canWrite}>
            <option value="">—</option>
            <UnitOptions units={choices} />
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="item-note" className={fieldLabel}>
          {t('shopping.note')}
        </label>
        <Input id="item-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canWrite} />
      </div>
      {canWrite && (
        <>
          <Button
            variant="primary"
            className="w-full"
            disabled={busy}
            onClick={() =>
              void act(() => updateListItem(item.id!, { qty: qty.trim() ? parseQty(qty) : null, unit_id: unitId || null, note: note.trim() || null }))
            }
          >
            {t('common.save')}
          </Button>
          <div className="flex gap-2">
            {item.source === 'below_min' ? (
              <Button className={cn('flex-1')} disabled={busy} onClick={() => void act(() => updateListItem(item.id!, { dismissed: true }))}>
                {t('shopping.notNow')}
              </Button>
            ) : (
              <Button variant="destructive" className="flex-1" disabled={busy} onClick={() => void act(() => deleteListItem(item.id!))}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('shopping.remove')}
              </Button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
