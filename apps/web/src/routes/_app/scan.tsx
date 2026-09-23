import { createFileRoute } from '@tanstack/react-router';
import { Keyboard, Usb } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CameraScanner } from '@/components/scan/CameraScanner';
import { ScanResult } from '@/components/scan/ScanResult';
import { SCAN_EVENT } from '@/components/scan/WedgeListener';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { resolveScan, type Resolved } from '@/lib/resolve';

export const Route = createFileRoute('/_app/scan')({
  component: ScanPage,
});

interface Hit {
  id: number;
  at: Date;
  result: Resolved;
}

/** Scan HUD (MASTER_PLAN §5.2): camera + USB scanner + typed code; stays open for rapid-fire use. */
function ScanPage() {
  const { t } = useTranslation();
  const [hits, setHits] = useState<Hit[]>([]);
  const [code, setCode] = useState('');
  const [live, setLive] = useState(false);

  const handle = useCallback(
    async (text: string) => {
      try {
        const result = await resolveScan(text);
        setHits((h) => [{ id: Date.now() + Math.random(), at: new Date(), result }, ...h].slice(0, 12));
      } catch {
        toast.error(t('scan.lookupFailed'));
      }
    },
    [t],
  );

  useEffect(() => {
    const onScan = (e: Event) => void handle((e as CustomEvent<string>).detail);
    window.addEventListener(SCAN_EVENT, onScan);
    return () => window.removeEventListener(SCAN_EVENT, onScan);
  }, [handle]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    void handle(code);
    setCode('');
  }

  const [latest, ...earlier] = hits;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.scan')}</h1>
        <span className="tabular mb-1.5 inline-flex items-center gap-1.5 text-[12px] text-muted">
          <Usb className="h-3.5 w-3.5" aria-hidden />
          {t('scan.usbReady')}
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="relative min-w-0">
          <CameraScanner
            onDetect={(text) => void handle(text)}
            onRunningChange={setLive}
            className="aspect-[3/4] max-h-[64dvh] w-full sm:aspect-[4/3] lg:aspect-[4/3.4] lg:max-h-none"
          />
          {/* Over the live picture (HUD); under the viewfinder while the camera is off. */}
          {latest && (
            <div className={live ? 'absolute inset-x-3 bottom-3 z-20' : 'mt-3'} aria-live="polite">
              <ScanResult key={latest.id} result={latest.result} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <label htmlFor="scan-code" className="flex items-center gap-2 text-[13px] font-medium text-muted">
                <Keyboard className="h-4 w-4" aria-hidden />
                {t('scan.typeCode')}
              </label>
              <div className="flex gap-2">
                <Input
                  id="scan-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="HL:LOC:7K2P9Q"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular uppercase"
                />
                <Button type="submit" variant="accent" disabled={!code.trim()}>
                  {t('scan.find')}
                </Button>
              </div>
            </form>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="font-display text-[17px] font-semibold">{t('scan.recent')}</h2>
            {earlier.length === 0 ? (
              <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('scan.recentEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {earlier.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 rounded-2xl bg-white/[0.03] px-3 py-2.5">
                    <span className="tabular w-11 shrink-0 text-[11.5px] text-faint">
                      {h.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px]">
                      {h.result.status === 'place' ? h.result.place.path : t(`scan.short.${h.result.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
