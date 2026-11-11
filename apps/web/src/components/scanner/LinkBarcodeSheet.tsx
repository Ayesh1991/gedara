// A barcode the bin scanner read that no product has yet (Phase 11). Link it once: pick the product
// and say what one scan means (one piece, or a pack of 400 ml). The scans of it that were waiting are
// then applied in the order they were made, and every later scan just works. A product that isn't in
// Gedara yet is made with the normal new-product form (which looks the barcode up on Open Food Facts).
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel, selectClass, usePantry } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { invalidateScanner, linkBarcode, scannerErrorKey } from '@/lib/scanner/queries';

export function LinkBarcodeSheet({
  open,
  onClose,
  householdId,
  scanId,
  code,
  waiting,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  scanId: string;
  code: string;
  /** How many scans of this code are waiting. */
  waiting: number;
  onLinked: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { products, units } = usePantry(householdId);
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
  const product = (products.data ?? []).find((p) => p.id === productId);
  const allUnits = [...(units.data?.values() ?? [])];
  const stockUnit = product ? units.data?.get(product.stock_unit_id) : undefined;
  // Units that measure the same kind of thing as the product's own (g ↔ kg, ml ↔ L).
  const unitOptions = allUnits.filter((u) => stockUnit && (u.id === stockUnit.id || (u.dimension === stockUnit.dimension && u.dimension !== 'other')));
  const n = Number(qty);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !productId || !(n > 0)) return;
    setBusy(true);
    try {
      const r = await linkBarcode(householdId, scanId, code, productId, { qty: n, unitId: unitId || null });
      toast.success(t('scanner.link.done', { count: r.applied }));
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
        <p className="text-[14px] text-muted">{t('scanner.link.intro', { count: waiting })}</p>
        <code className="tabular self-start rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-[13px] break-all">{code}</code>
        <div className="flex flex-col gap-2">
          <label className={fieldLabel} htmlFor="scanner-link-product">
            {t('scanner.link.product')}
          </label>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('scanner.link.filter')} aria-label={t('scanner.link.filter')} />
          <select
            id="scanner-link-product"
            className={selectClass}
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setUnitId('');
            }}
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
          {t('scanner.link.save', { count: waiting })}
        </Button>
        <Link to="/pantry" search={{ new: code }} className="self-center text-[14px] text-accent-b underline">
          {t('scanner.link.newProduct')}
        </Link>
        <p className="-mt-2 text-center text-[12.5px] text-faint">{t('scanner.link.newProductHint')}</p>
      </form>
    </Sheet>
  );
}
