// One bin-scanner scan as a card: what happened ("Highland Yoghurt −1 · 5 left"), and what you can
// do about it: Undo, link an unknown barcode, "Add 1 more" after a bill, apply or drop a held scan.
// Used by the pop-ups and the Bin-scanner pages. The scanned text is untrusted and is only ever
// rendered as plain text.
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Barcode, CircleHelp, PackageCheck, PackageMinus, PackageOpen, PackagePlus, Pause, Search, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { canUndoScan, formatAmount, formatChange, packsLeft, statusTone, type Tone } from '@/lib/scanner/format';
import { invalidateScanner, resolveScan, scannerErrorKey, undoScan, type BinScan } from '@/lib/scanner/queries';
import { cn } from '@/lib/utils';
import { LinkBarcodeSheet } from './LinkBarcodeSheet';

const TONE: Record<Tone, string> = {
  teal: 'border-teal/40',
  info: 'border-info/45',
  caution: 'border-caution/45',
  red: 'border-red/50',
  muted: 'border-line-2',
};
const TEXT: Record<Tone, string> = {
  teal: 'text-teal',
  info: 'text-info',
  caution: 'text-caution',
  red: 'text-red',
  muted: 'text-muted',
};

function Icon({ scan }: { scan: BinScan }) {
  const c = 'h-[18px] w-[18px]';
  if (scan.kind === 'undo') return <Undo2 className={c} />;
  switch (scan.status) {
    case 'unknown':
      return <Barcode className={c} />;
    case 'bill_guard':
      return <CircleHelp className={c} />;
    case 'held':
      return <Pause className={c} />;
    case 'added':
      return <PackagePlus className={c} />;
    case 'opened':
      return <PackageOpen className={c} />;
    case 'wasted':
      return <Trash2 className={c} />;
    case 'checked':
      return <Search className={c} />;
    case 'moved':
    case 'in_jar':
      return <PackageCheck className={c} />;
    case 'error':
    case 'not_pantry':
    case 'nothing_to_open':
      return <TriangleAlert className={c} />;
    default:
      return <PackageMinus className={c} />;
  }
}

export function ScanCard({
  scan,
  householdId,
  canWrite,
  linkedTo,
  waitingSame = 1,
  when,
  onHandled,
  className,
}: {
  scan: BinScan;
  householdId: string;
  canWrite: boolean;
  /** For an unknown barcode that has been linked meanwhile: the product's name. */
  linkedTo?: string | null;
  /** How many waiting scans share this code. */
  waitingSame?: number;
  /** Time of the scan, already formatted (lists show it; pop-ups don't). */
  when?: string;
  onHandled?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const s = scan;
  const r = s.result;
  const tone = s.undone_at ? 'muted' : statusTone(s.status);
  const unit = r.unit ?? null;
  const packs = packsLeft(s.left_qty, r.pack, r.sized);
  const left = s.left_qty != null ? formatAmount(s.left_qty, unit) : '';
  const title = r.name ?? (s.status === 'unknown' ? t(s.mode === 'check' ? 'scanner.card.linkThis' : 'scanner.card.newBarcode') : s.kind === 'undo' ? t('scanner.card.undoKey') : t('scanner.card.something'));
  const showChange = ['used', 'wasted', 'added'].includes(s.status) && s.qty != null;

  async function run(fn: () => Promise<unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      await invalidateScanner(qc, householdId);
      onHandled?.();
    } catch (e) {
      toast.error(t(`scanner.errors.${scannerErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn('glass flex flex-col gap-3 rounded-[var(--r)] border p-4', TONE[tone], s.undone_at && 'opacity-70', className)}
      data-testid="scanner-scan"
      data-status={s.status}
    >
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5', TEXT[tone])} aria-hidden>
          <Icon scan={s} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 font-display text-[17px] font-semibold">
            <span className="min-w-0 truncate" data-testid="scanner-scan-title">
              {title}
            </span>
            {showChange && <span className={cn('tabular', TEXT[tone])}>{formatChange(s.qty ?? 0, unit)}</span>}
          </div>
          <p className="text-[13px] text-muted">
            {s.undone_at
              ? t('scanner.card.undone')
              : t(`scanner.status.${s.status}`, {
                  left,
                  count: s.count,
                  qty: formatAmount(Math.abs(s.qty ?? 0), unit),
                  jar: r.jar ?? t('scanner.card.theJar'),
                  billQty: formatAmount(Number(r.bill_qty ?? 0), unit),
                  reason: t(`scanner.undoReason.${r.reason === 'changed' || r.reason === 'late' ? r.reason : 'nothing'}`),
                })}
            {!s.undone_at && (s.status === 'used' || s.status === 'no_stock') && r.on_list ? ` · ${t('scanner.card.onList')}` : ''}
          </p>
          {(s.status === 'unknown' || s.status === 'not_pantry' || !r.name) && s.code && (
            <code className="tabular mt-1 block truncate font-mono text-[12px] text-faint">{s.code}</code>
          )}
          {s.status === 'unknown' && linkedTo && <p className="mt-1 text-[13px] text-teal">{t('scanner.card.linkedTo', { name: linkedTo })}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {s.left_qty != null && !['unknown', 'not_pantry', 'held'].includes(s.status) && (
            <span className="tabular text-[14px] font-semibold" data-testid="scanner-scan-left">
              {packs != null ? t('scanner.card.packsLeft', { count: packs }) : t('scanner.card.left', { left })}
            </span>
          )}
          {s.mode && <span className="text-[11.5px] text-faint">{t(`scanner.mode.${s.mode}`)}</span>}
          {when && <span className="tabular text-[11.5px] text-faint">{when}</span>}
        </div>
      </div>

      {canWrite && !s.undone_at && (
        <div className="flex flex-wrap gap-2">
          {s.status === 'unknown' &&
            (linkedTo ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => resolveScan(s.id, 'apply'), t('scanner.card.applied'))}>
                {t('scanner.card.apply', { count: waitingSame })}
              </Button>
            ) : (
              <Button size="sm" variant="accent" onClick={() => setLinking(true)}>
                <Barcode className="h-4 w-4" aria-hidden />
                {t('scanner.card.link')}
              </Button>
            ))}
          {s.status === 'bill_guard' && (
            <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => resolveScan(s.id, 'apply'), t('scanner.card.applied'))}>
              {t('scanner.card.addAnyway', { count: s.count })}
            </Button>
          )}
          {s.status === 'held' && (
            <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => resolveScan(s.id, 'apply'), t('scanner.card.applied'))}>
              {t('scanner.card.applyHeld')}
            </Button>
          )}
          {['unknown', 'bill_guard', 'held'].includes(s.status) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => resolveScan(s.id, 'dismiss'))}>
              {t('scanner.card.dismiss')}
            </Button>
          )}
          {s.status === 'no_stock' && s.product_id && (
            <Link
              to="/pantry/$productId"
              params={{ productId: s.product_id }}
              className="inline-flex h-9 items-center rounded-xl px-3 text-sm text-accent-b hover:bg-white/5"
            >
              {t('scanner.card.stillHave')}
            </Link>
          )}
          {canUndoScan(s) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => undoScan(s.id), t('scanner.card.undoneToast'))} className="ml-auto">
              <Undo2 className="h-4 w-4" aria-hidden />
              {t('common.undo')}
            </Button>
          )}
        </div>
      )}

      {linking && s.code && (
        <LinkBarcodeSheet
          open={linking}
          onClose={() => setLinking(false)}
          householdId={householdId}
          scanId={s.id}
          code={s.code}
          waiting={waitingSame}
          mode={s.mode}
          onLinked={() => {
            setLinking(false);
            onHandled?.();
          }}
        />
      )}
    </div>
  );
}
