// A barcode the bin scanner read that no product has yet (Phase 11). Link it once: pick the product
// and say what one scan means (one piece, or a pack of 400 ml). The scans of it that were waiting are
// then applied in the order they were made, and every later scan just works. A product that isn't in
// Gedara yet is made with the normal new-product form (which looks the barcode up on Open Food Facts).
// Suggestions (14 Nov): products with no barcode yet first (bills bring them in without one), ranked
// by the name Open Food Facts knows for the barcode. A scan made in Check mode only links: nothing is
// used or added.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel, selectClass, usePantry } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { lookupOff } from '@/lib/off';
import { formatAmount } from '@/lib/scanner/format';
import { invalidateScanner, linkBarcode, scannerErrorKey } from '@/lib/scanner/queries';
import { linkOnly, packFromOff, suggestProducts } from '@/lib/scanner/suggest';
import { cn } from '@/lib/utils';

export function LinkBarcodeSheet({
  open,
  onClose,
  householdId,
  scanId,
  code,
  waiting,
  mode,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  scanId: string;
  code: string;
  /** How many scans of this code are waiting. */
  waiting: number;
  /** The scan's mode: a Check scan only links. */
  mode?: string | null;
  onLinked: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { products, units, barcodes } = usePantry(householdId);
  const off = useQuery({
    queryKey: ['off', code],
    queryFn: () => lookupOff(code),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });
  const only = linkOnly(mode, waiting);
  const [filter, setFilter] = useState('');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (products.data ?? []).filter(
      (p) => !p.archived && (!f || p.id === productId || p.name.toLowerCase().includes(f) || (p.name_si ?? '').includes(filter.trim())),
    );
  }, [products.data, filter, productId]);
  const suggestions = useMemo(
    () => suggestProducts(products.data ?? [], new Set((barcodes.data ?? []).map((b) => b.product_id)), off.data?.name),
    [products.data, barcodes.data, off.data],
  );
  const product = (products.data ?? []).find((p) => p.id === productId);
  const allUnits = [...(units.data?.values() ?? [])];
  const stockUnit = product ? units.data?.get(product.stock_unit_id) : undefined;
  // Units that measure the same kind of thing as the product's own (g ↔ kg, ml ↔ L).
  const unitOptions = allUnits.filter((u) => stockUnit && (u.id === stockUnit.id || (u.dimension === stockUnit.dimension && u.dimension !== 'other')));
  const n = Number(qty);

  function choose(id: string) {
    setProductId(id);
    const p = (products.data ?? []).find((x) => x.id === id);
    const dim = p ? units.data?.get(p.stock_unit_id)?.dimension : undefined;
    const pack = packFromOff(off.data?.pack, dim);
    const packUnit = pack ? allUnits.find((u) => u.code === pack.unitCode && u.dimension === dim) : undefined;
    if (pack && packUnit) {
      setQty(String(pack.qty));
      setUnitId(packUnit.id);
    } else {
      setQty('1');
      setUnitId('');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !productId || !(n > 0)) return;
    setBusy(true);
    try {
      const r = await linkBarcode(householdId, scanId, code, productId, { qty: n, unitId: unitId || null });
      // r.applied counts this scan too; more means other waiting scans of the code were applied.
      toast.success(r.applied > 1 || !only ? t('scanner.link.done', { count: r.applied }) : t('scanner.link.linked', { name: product?.name ?? '' }));
      await invalidateScanner(qc, householdId);
      onLinked();
    } catch (err) {
      toast.error(t(`scanner.errors.${scannerErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('scanner.link.title')}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid="scanner-link-form">
        <p className="text-[14px] text-muted">{only ? t('scanner.link.linkOnly') : t('scanner.link.intro', { count: waiting })}</p>
        <div className="flex flex-col gap-1">
          <code className="tabular self-start rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-[13px] break-all">{code}</code>
          {off.isFetching ? (
            <span className="text-[12.5px] text-faint">{t('scanner.link.looking')}</span>
          ) : (
            off.data?.name && (
              <span className="text-[13px] text-muted" data-testid="scanner-link-off">
                {t('scanner.link.offName', { name: off.data.name })}
              </span>
            )
          )}
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="scanner-link-suggestions">
            <span className={fieldLabel}>{t('scanner.link.suggest')}</span>
            {suggestions.map((sg) => {
              const p = (products.data ?? []).find((x) => x.id === sg.id);
              const unitCode = p ? (units.data?.get(p.stock_unit_id)?.code ?? null) : null;
              const picked = sg.id === productId;
              return (
                <button
                  key={sg.id}
                  type="button"
                  onClick={() => choose(sg.id)}
                  aria-pressed={picked}
                  className={cn(
                    'flex min-h-12 flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors',
                    picked ? 'border-accent-b bg-white/10' : 'border-line-2 bg-white/[.03] hover:bg-white/5',
                  )}
                >
                  <span className="text-[15px] font-medium">{sg.name}</span>
                  <span className="text-[12.5px] text-muted">
                    {sg.inStock > 0 && <span className="tabular">{t('scanner.link.inStock', { qty: formatAmount(sg.inStock, unitCode) })} · </span>}
                    {sg.hasBarcode ? t('scanner.link.hasBarcode') : t('scanner.link.noBarcodeYet')}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <label className={fieldLabel} htmlFor="scanner-link-product">
            {t('scanner.link.product')}
          </label>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('scanner.link.filter')} aria-label={t('scanner.link.filter')} />
          <select
            id="scanner-link-product"
            className={selectClass}
            value={productId}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">{t('scanner.link.choose')}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {product && (
          <div>
            <span className={fieldLabel}>{t('scanner.link.pack')}</span>
            <div className="flex gap-2">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                aria-label={t('scanner.link.packQty')}
                className="max-w-[130px]"
              />
              <select className={selectClass} value={unitId || stockUnit?.id || ''} onChange={(e) => setUnitId(e.target.value)} aria-label={t('scanner.link.packUnit')}>
                {unitOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1.5 text-[12.5px] text-faint">{t('scanner.link.packHint')}</p>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy || !productId || !(n > 0)}>
          {only ? t('scanner.link.linkButton') : t('scanner.link.save', { count: waiting })}
        </Button>
        <Link to="/pantry" search={{ new: code }} className="self-center text-[14px] text-accent-b underline">
          {t('scanner.link.newProduct')}
        </Link>
        <p className="-mt-2 text-center text-[12.5px] text-faint">{t('scanner.link.newProductHint')}</p>
      </form>
    </Sheet>
  );
}
