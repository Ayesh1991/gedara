import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRightLeft, CircleAlert, CircleCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { invalidateLabels } from '@/lib/labels/blank';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { invalidatePantry, type Product } from '@/lib/pantry/queries';
import { invalidateThings, productToThing, toThingErrorKey } from '@/lib/things/queries';

/** A category (or its main category) whose purchases are Things, not pantry stock (e.g. Books). */
export function isThingCategory(categories: CategoryRow[], id: string | null | undefined): boolean {
  const c = id ? categories.find((x) => x.id === id) : undefined;
  if (!c) return false;
  const parent = c.parent_id ? categories.find((x) => x.id === c.parent_id) : undefined;
  return (c.default_destiny ?? parent?.default_destiny) === 'asset';
}

/** Products that are really Things (Phase 7e: books entered in Pantry): nothing in stock, Things category. */
export function misplacedProducts(products: Product[], categories: CategoryRow[]): Product[] {
  return products.filter((p) => !p.archived && p.stock.qty <= 0 && isThingCategory(categories, p.category_id));
}

async function refresh(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  await Promise.all([invalidatePantry(qc, householdId), invalidateThings(qc, householdId), invalidateLabels(qc, householdId)]);
}

/**
 * Pantry banner: "N products are in Things categories → Move to Things". Moves each with
 * rpc_product_to_thing (barcodes, QR labels and photo go along); lists any that can't move and why.
 */
export function MoveToThingsBanner({ householdId, products, categories }: { householdId: string; products: Product[]; categories: CategoryRow[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useMemo(() => misplacedProducts(products, categories), [products, categories]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<Array<{ name: string; reason: string }>>([]);
  const [moved, setMoved] = useState<number | null>(null);

  if (!list.length && moved === null) return null;
  const catNames = [...new Set(list.map((p) => categories.find((c) => c.id === p.category_id)?.name).filter(Boolean))].join(', ');
  const chosen = list.filter((p) => picked[p.id] ?? true);

  async function move() {
    setProgress({ done: 0, total: chosen.length });
    setFailed([]);
    let ok = 0;
    const bad: Array<{ name: string; reason: string }> = [];
    for (const [i, p] of chosen.entries()) {
      try {
        await productToThing(p.id);
        ok += 1;
      } catch (e) {
        bad.push({ name: p.name, reason: t(`pantry.toThings.errors.${toThingErrorKey(e)}`) });
      }
      setProgress({ done: i + 1, total: chosen.length });
    }
    await refresh(qc, householdId);
    setProgress(null);
    setFailed(bad);
    setMoved(ok);
    toast.success(t('pantry.toThings.moved', { count: ok }));
  }

  return (
    <>
      {list.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-info/40 p-4" data-testid="to-things-banner">
          <ArrowRightLeft className="h-5 w-5 shrink-0 text-info" aria-hidden />
          <p className="min-w-0 flex-1 text-[14px]">{t('pantry.toThings.banner', { count: list.length, categories: catNames })}</p>
          <Button size="sm" variant="accent" onClick={() => setOpen(true)}>
            {t('pantry.toThings.open')}
          </Button>
        </Card>
      )}
      <Sheet
        open={open}
        onClose={() => {
          if (progress) return;
          setOpen(false);
          setMoved(null);
        }}
        title={t('pantry.toThings.title')}
      >
        {moved !== null && !progress ? (
          <div className="flex flex-col gap-3" data-testid="to-things-done">
            <p className="flex items-center gap-2 text-[15px]">
              <CircleCheck className="h-5 w-5 text-teal" aria-hidden />
              {t('pantry.toThings.moved', { count: moved })}
            </p>
            {failed.length > 0 && (
              <ul className="flex flex-col gap-1 text-[13px]">
                {failed.map((f) => (
                  <li key={f.name} className="flex items-start gap-2 text-caution">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>
                      {f.name}: {f.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Button
              onClick={() => {
                setOpen(false);
                setMoved(null);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('pantry.toThings.intro')}</p>
            <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
              {list.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-10 items-center gap-2.5 rounded-xl px-2 text-[14px] hover:bg-white/[0.04]">
                    <input
                      type="checkbox"
                      checked={picked[p.id] ?? true}
                      disabled={Boolean(progress)}
                      onChange={(e) => setPicked((x) => ({ ...x, [p.id]: e.target.checked }))}
                      className="h-5 w-5 shrink-0 accent-[var(--accent-a)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <Button variant="primary" disabled={Boolean(progress) || chosen.length === 0} onClick={() => void move()} className="w-full">
              {progress ? t('pantry.toThings.moving', { done: progress.done, total: progress.total }) : t('pantry.toThings.move', { count: chosen.length })}
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

/** On a product page: this product is really a Thing → move it and open the Thing. */
export function MoveToThingButton({ householdId, product }: { householdId: string; product: Product }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function move() {
    setBusy(true);
    try {
      const id = await productToThing(product.id);
      await refresh(qc, householdId);
      toast.success(t('pantry.toThings.movedOne', { name: product.name }));
      void navigate({ to: '/things/$assetId', params: { assetId: id } });
    } catch (e) {
      toast.error(t(`pantry.toThings.errors.${toThingErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 border-info/40 p-4" data-testid="to-thing-one">
      <ArrowRightLeft className="h-5 w-5 shrink-0 text-info" aria-hidden />
      <p className="min-w-0 flex-1 text-[14px]">{t('pantry.toThings.one')}</p>
      <Button size="sm" variant="accent" disabled={busy} onClick={() => void move()}>
        {t('pantry.toThings.moveOne')}
      </Button>
    </Card>
  );
}
