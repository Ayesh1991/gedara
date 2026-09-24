import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { resolveScan } from '@/lib/resolve';
import { createWedgeDetector, isTypingTarget } from '@/lib/wedge';
import { ScanResult } from './ScanResult';

export const SCAN_EVENT = 'gedara:scan';

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
