import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, CircleAlert, Merge, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Qty } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { invalidateLabels } from '@/lib/labels/blank';
import { invalidatePantry, mergeErrorKey, mergeProduct, type Product } from '@/lib/pantry/queries';
import type { UnitMap } from '@/lib/pantry/units';
import { invalidateScale } from '@/lib/scale/queries';
import { similarity, trigrams } from '@/lib/spine/match';

/** Other products to merge into: closest names first, then by name; filtered by the search box. */
export function mergeCandidates(product: Pick<Product, 'id' | 'name'>, products: Product[], q: string): Product[] {
  const mine = trigrams(product.name);
  const needle = q.trim().toLowerCase();
  return products
    .filter((p) => p.id !== product.id && !p.archived && (!needle || p.name.toLowerCase().includes(needle) || p.name_si?.includes(q.trim())))
    .map((p) => ({ p, s: similarity(mine, trigrams(p.name)) }))
    .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

/**
 * Product page: "Merge into…" a duplicate (Phase 7f). Pick the product to keep, see what moves, and
 * confirm; everything goes to it in one step (rpc_product_merge) and this product is archived.
 */
export function MergeProductSheet({
  open,
  onClose,
  householdId,
  product,
  products,
  units,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  product: Product;
  products: Product[];
  units: UnitMap;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => mergeCandidates(product, products, q).slice(0, 40), [product, products, q]);
  const target = targetId ? products.find((p) => p.id === targetId) : undefined;
  const unit = units.get(product.stock_unit_id);
  const targetUnit = target ? units.get(target.stock_unit_id) : undefined;
  const converts = Boolean(target && target.stock_unit_id !== product.stock_unit_id);

  function close() {
    if (busy) return;
    setQ('');
    setTargetId(null);
    setError(null);
    onClose();
  }

  async function merge() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await mergeProduct(product.id, target.id);
      await Promise.all([invalidatePantry(qc, householdId), invalidateScale(qc, householdId), invalidateLabels(qc, householdId)]);
      toast.success(t('pantry.merge.done', { target: target.name }));
      setBusy(false);
      close();
      void navigate({ to: '/pantry/$productId', params: { productId: target.id } });
    } catch (e) {
      setError(t(`pantry.merge.errors.${mergeErrorKey(e)}`));
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={close} title={t('pantry.merge.title', { name: product.name })}>
      {!target ? (
        <div className="flex flex-col gap-3" data-testid="merge-pick">
          <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('pantry.merge.intro')}</p>
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('pantry.merge.search')}
              aria-label={t('pantry.merge.search')}
              className="pl-10"
            />
          </label>
          {list.length === 0 ? (
            <p className="text-[14px] text-muted">{t('pantry.merge.none')}</p>
          ) : (
            <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setTargetId(p.id)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-left text-[14.5px] hover:bg-white/[0.04]"
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <Qty qty={p.stock.qty} unit={units.get(p.stock_unit_id)} className="text-[13px] text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-testid="merge-confirm">
          <button
            type="button"
            onClick={() => {
              setTargetId(null);
              setError(null);
            }}
            disabled={busy}
            className="-mb-1 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('pantry.merge.back')}
          </button>
          <div className="flex items-center gap-3 text-[15px]">
            <span className="min-w-0 flex-1 truncate text-[#c5cce3]">{product.name}</span>
            <Merge className="h-5 w-5 shrink-0 rotate-90 text-accent-b" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-right font-semibold">{target.name}</span>
          </div>
          <p className="text-[14px] leading-relaxed">{t('pantry.merge.moves', { name: product.name, target: target.name })}</p>
          {product.stock.qty > 0 && (
            <p className="text-[14px]">
              {t('pantry.merge.stock')} <Qty qty={product.stock.qty} unit={unit} />
              {converts && <span className="text-muted"> · {t('pantry.merge.convert', { unit: targetUnit?.code ?? '' })}</span>}
            </p>
          )}
          <p className="flex items-start gap-2 rounded-xl border border-caution/40 bg-caution/10 px-3 py-2.5 text-[13.5px] text-caution">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{t('pantry.merge.irreversible')}</span>
          </p>
          {error && (
            <p role="alert" className="text-[13.5px] text-red">
              {error}
            </p>
          )}
          <Button variant="primary" className="w-full" disabled={busy} onClick={() => void merge()}>
            {busy ? t('pantry.merge.merging') : t('pantry.merge.confirm', { target: target.name })}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

/** On an archived, merged product: where everything went. */
export function MergedIntoBanner({ product, products }: { product: Product; products: Product[] }) {
  const { t } = useTranslation();
  if (!product.merged_into_id) return null;
  const target = products.find((p) => p.id === product.merged_into_id);
  if (!target) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 border-info/40 p-4" data-testid="merged-into">
      <Merge className="h-5 w-5 shrink-0 text-info" aria-hidden />
      <p className="min-w-0 flex-1 text-[14px]">{t('pantry.merge.mergedInto', { target: target.name })}</p>
      <Link to="/pantry/$productId" params={{ productId: target.id }} className="text-[14px] font-semibold text-accent-b">
        {t('pantry.merge.goTo', { target: target.name })}
      </Link>
    </Card>
  );
}
