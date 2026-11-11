// Bin-scanner pop-ups on every screen (Phase 11; same idea as the kitchen scale's). A new scan slides
// up as a card with Undo; plain results leave after 8 s, scans that need you (a new barcode, Add
// after a bill, a paused scanner) stay until handled or closed. Each device has its own switch
// (localStorage: a per-device convenience, never data). The Bin-scanner page shows scans itself, so
// no pop-ups there.
import { useRouterState } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { undoStock } from '@/lib/pantry/queries';
import { formatAmount, needsYou } from '@/lib/scanner/format';
import { invalidateScanner, type BinScan } from '@/lib/scanner/queries';
import { SETTLED_EVENT, type SettledDetail } from '@/lib/scanner/settle';
import { ScanCard } from './ScanCard';
import { useScannerLive } from './useScannerLive';

const KEY = 'gedara.scanner.popups';
const PLAIN_MS = 8000;
// "Check" changes nothing and is answered on the scanner's own screen: no pop-up.
const SHOWN: ReadonlySet<string> = new Set([
  'used', 'wasted', 'opened', 'added', 'moved', 'in_jar', 'no_stock', 'nothing_to_open', 'unknown', 'bill_guard', 'held', 'undo', 'error',
]);

export function scannerPopupsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setScannerPopupsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // private mode: stays on for this visit
  }
  window.dispatchEvent(new Event('gedara-scanner-popups'));
}

export function ScannerPopups({ householdId, canWrite }: { householdId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const onScannerPage = useRouterState({ select: (s) => s.location.pathname === '/pantry/scanner' });
  const [enabled, setEnabled] = useState(scannerPopupsEnabled);
  const [cards, setCards] = useState<BinScan[]>([]);

  useEffect(() => {
    const sync = () => setEnabled(scannerPopupsEnabled());
    window.addEventListener('gedara-scanner-popups', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('gedara-scanner-popups', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const dismiss = useCallback((id: string) => setCards((cs) => cs.filter((c) => c.id !== id)), []);

  // A bill just stocked something the scanner's Add had already put in: say that it wasn't counted
  // twice, with Undo (shown whatever the pop-up switch says: it is about the bill the person just saved).
  const qc = useQueryClient();
  useEffect(() => {
    const onSettled = (e: Event) => {
      const d = (e as CustomEvent<SettledDetail>).detail;
      if (!d?.items?.length) return;
      const what = d.items.map((i) => `${formatAmount(i.qty, i.unit)} × ${i.name}`).join(', ');
      toast.info(t('scanner.settled.message', { what }), {
        duration: 12_000,
        action: canWrite
          ? {
              label: t('common.undo'),
              onClick: () => {
                undoStock(d.correlation_id).then(
                  () => invalidateScanner(qc, householdId),
                  () => toast.error(t('scanner.errors.cantUndo')),
                );
              },
            }
          : undefined,
      });
      void invalidateScanner(qc, householdId);
    };
    window.addEventListener(SETTLED_EVENT, onSettled);
    return () => window.removeEventListener(SETTLED_EVENT, onSettled);
  }, [t, qc, householdId, canWrite]);

  const onScan = useCallback(
    (s: BinScan, kind: 'insert' | 'update') => {
      if (kind === 'update') {
        // Handled elsewhere (another phone, or the scanner's own Undo): settle the card here too.
        setCards((cs) => cs.flatMap((c) => (c.id !== s.id ? [c] : needsYou(s.status) && !s.undone_at ? [{ ...c, ...s }] : [])));
        return;
      }
      if (!SHOWN.has(s.status)) return;
      // The scanner's Undo: the card it took back goes, a short note stays.
      setCards((cs) => [s, ...cs.filter((c) => c.id !== s.id && !(s.kind === 'undo' && c.id === (s.result.target_id as string | undefined)))].slice(0, 3));
      if (!needsYou(s.status)) setTimeout(() => dismiss(s.id), PLAIN_MS);
    },
    [dismiss],
  );

  const active = enabled && !onScannerPage;
  useScannerLive(householdId, onScan, active);
  if (!active || cards.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-2 px-3 lg:right-6 lg:bottom-6 lg:left-auto lg:w-[420px] lg:items-stretch"
      aria-live="polite"
      data-testid="scanner-popups"
    >
      {cards.map((c) => (
        <div key={c.id} className="pointer-events-auto relative w-full max-w-md motion-safe:animate-[slide-up_.25s_ease-out]">
          <ScanCard scan={c} householdId={householdId} canWrite={canWrite} onHandled={() => dismiss(c.id)} className="pr-11 shadow-2xl" />
          <button
            type="button"
            onClick={() => dismiss(c.id)}
            aria-label={t('common.close')}
            className="absolute top-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-white/5"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
