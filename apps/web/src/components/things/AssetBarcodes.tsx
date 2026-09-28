import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Barcode, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ScanField } from '@/components/scan/ScanField';
import { addAssetBarcode, assetBarcodesQuery, invalidateThings, removeAssetBarcode } from '@/lib/things/queries';

/** A thing's retail barcodes (a book's ISBN, Phase 7e): scanning one opens the thing. */
export function AssetBarcodes({ householdId, assetId, canWrite }: { householdId: string; assetId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const all = useQuery(assetBarcodesQuery(householdId));
  const mine = (all.data ?? []).filter((b) => b.asset_id === assetId);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    try {
      await fn();
      await invalidateThings(qc, householdId);
      done?.();
    } catch (e) {
      const dup = (e as { code?: string } | null)?.code === '23505';
      toast.error(t(dup ? 'things.barcodes.duplicate' : 'things.barcodes.failed'));
    } finally {
      setBusy(false);
    }
  }

  if (!mine.length && !canWrite) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-white/[0.02] px-3 py-2.5" data-testid="asset-barcodes">
      <div className="text-[12px] text-muted">{t('things.barcodes.title')}</div>
      {mine.map((b) => (
        <div key={b.id} className="flex items-center gap-2 text-[13.5px]">
          <Barcode className="h-3.5 w-3.5 shrink-0 text-accent-b" aria-hidden />
          <span className="tabular min-w-0 flex-1 truncate">{b.barcode}</span>
          {canWrite && (
            <button
              type="button"
              disabled={busy}
              aria-label={t('things.barcodes.remove', { code: b.barcode })}
              onClick={() => void act(() => removeAssetBarcode(b.id))}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-white/5"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      ))}
      {canWrite && (
        <ScanField
          aria-label={t('things.barcodes.add')}
          placeholder={t('things.barcodes.placeholder')}
          inputMode="numeric"
          autoComplete="off"
          value={code}
          onChange={setCode}
          onScan={(v) => void act(() => addAssetBarcode(householdId, assetId, v), () => setCode(''))}
          inputClassName="h-10 px-3 text-[14px]"
          buttonClassName="h-10 w-10"
        />
      )}
    </div>
  );
}
