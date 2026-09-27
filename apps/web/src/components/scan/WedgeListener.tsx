import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { resolveScan } from '@/lib/resolve';
import { createWedgeDetector, isTypingTarget } from '@/lib/wedge';
import { ScanResult } from './ScanResult';

export const SCAN_EVENT = 'gedara:scan';

// A camera sheet (barcode field, "Put in a place" …) that is open takes USB scans for itself, so the
// USB scanner and the phone camera always do the same thing. Newest capture wins.
const captures: Array<{ fn: (text: string) => void }> = [];

/** While `active`, USB scanner reads go to `onScan` instead of the toast / Scan page. */
export function useScanCapture(onScan: (text: string) => void, active = true) {
  const ref = useRef(onScan);
  useEffect(() => {
    ref.current = onScan;
  }, [onScan]);
  useEffect(() => {
    if (!active) return;
    const entry = { fn: (text: string) => ref.current(text) };
    captures.push(entry);
    return () => {
      const i = captures.indexOf(entry);
      if (i >= 0) captures.splice(i, 1);
    };
  }, [active]);
}

/**
 * USB scanner (keyboard wedge) on every signed-in screen. On the Scan page the HUD handles the code
 * itself (via SCAN_EVENT); everywhere else the result card appears as a toast.
 */
export function WedgeListener() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const handle = createWedgeDetector({
      onScan: (text) => {
        const capture = captures.at(-1);
        if (capture) {
          capture.fn(text);
          return;
        }
        if (pathRef.current === '/scan') {
          window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: text }));
          return;
        }
        void resolveScan(text)
          .then((result) => {
            toast.custom(
              (id) => <ScanResult result={result} compact onNavigate={() => toast.dismiss(id)} className="w-[min(92vw,380px)]" />,
              { duration: 8000 },
            );
          })
          .catch(() => toast.error(t('scan.lookupFailed')));
      },
    });
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (handle(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [t]);

  return null;
}
