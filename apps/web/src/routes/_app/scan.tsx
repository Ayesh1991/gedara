import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Keyboard, Package, Usb, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { CouldntSync } from '@/components/offline/OfflineSync';
import { CameraScanner } from '@/components/scan/CameraScanner';
import { AddMode, ClaimMode, FillMode, PutMode, parsePut, type ScanHandler } from '@/components/scan/ScanModes';
import { ScanResult } from '@/components/scan/ScanResult';
import { SCAN_EVENT } from '@/components/scan/WedgeListener';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { membershipQuery } from '@/lib/queries';
import { resolveScan, type Resolved } from '@/lib/resolve';

// Modes (Phase 7b): ?add=thing|product · ?put=<kind>:<id> · ?fill=<placeId> · ?claim=<HL:TAG code>.
// Bad values are dropped (plain Scan screen) rather than showing an error page.
const SearchSchema = z.object({
  add: z.enum(['thing', 'product']).optional().catch(undefined),
  put: z.string().max(60).optional().catch(undefined),
  fill: z.uuid().optional().catch(undefined),
  claim: z.string().max(40).optional().catch(undefined),
});

export const Route = createFileRoute('/_app/scan')({
  validateSearch: SearchSchema,
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const membership = useQuery(membershipQuery);
  const householdId = membership.data?.household.id;
  const canWrite = membership.data ? membership.data.role !== 'viewer' : false;
  const [hits, setHits] = useState<Hit[]>([]);
  const [code, setCode] = useState('');
  const [live, setLive] = useState(false);
  const [bannerEl, setBannerEl] = useState<HTMLDivElement | null>(null);

  const put = parsePut(search.put);
  const mode = !canWrite ? null : search.claim ? 'claim' : put ? 'put' : search.fill ? 'fill' : search.add ? 'add' : null;

  // The active mode decides what a scan means; without one the HUD shows what was scanned.
  const modeRef = useRef<ScanHandler | null>(null);
  const register = useCallback((fn: ScanHandler | null) => {
    modeRef.current = fn;
  }, []);

  const show = useCallback(
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

  const handle = useCallback(
    (text: string) => {
      if (modeRef.current) modeRef.current(text);
      else void show(text);
    },
    [show],
  );

  const leaveClaim = useCallback(
    (text: string) => {
      void navigate({ search: {}, replace: true });
      void show(text);
    },
    [navigate, show],
  );

  useEffect(() => {
    const onScan = (e: Event) => handle((e as CustomEvent<string>).detail);
    window.addEventListener(SCAN_EVENT, onScan);
    return () => window.removeEventListener(SCAN_EVENT, onScan);
  }, [handle]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    handle(code);
    setCode('');
  }

  const [latest, ...earlier] = hits;
  const modeNode =
    !householdId || !mode ? null : mode === 'claim' ? (
      <ClaimMode key={search.claim} householdId={householdId} code={search.claim!} register={register} bannerEl={bannerEl} onScanElsewhere={leaveClaim} />
    ) : mode === 'put' ? (
      <PutMode key={search.put} householdId={householdId} target={put!} register={register} bannerEl={bannerEl} />
    ) : mode === 'fill' ? (
      <FillMode key={search.fill} householdId={householdId} placeId={search.fill!} register={register} bannerEl={bannerEl} />
    ) : (
      <AddMode key={search.add} householdId={householdId} kind={search.add!} register={register} bannerEl={bannerEl} />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.scan')}</h1>
        <span className="tabular mb-1.5 inline-flex items-center gap-1.5 text-[12px] text-muted">
          <Usb className="h-3.5 w-3.5" aria-hidden />
          {t('scan.usbReady')}
        </span>
      </div>

      {!mode && canWrite && (
        <div className="-mt-1 flex flex-wrap gap-2" aria-label={t('scan.modes.quickAdd')}>
          <Link to="/scan" search={{ add: 'product' }} className="glass inline-flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[14px]">
            <Package className="h-4 w-4 text-accent-b" aria-hidden />
            {t('scan.modes.addProducts')}
          </Link>
          <Link to="/scan" search={{ add: 'thing' }} className="glass inline-flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[14px]">
            <Wrench className="h-4 w-4 text-accent-b" aria-hidden />
            {t('scan.modes.addThings')}
          </Link>
        </div>
      )}

      {/* The active mode's banner (what a scan does now + Done) sits above the viewfinder. */}
      <div ref={setBannerEl} className="empty:hidden" />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="relative min-w-0">
          <CameraScanner
            onDetect={handle}
            onRunningChange={setLive}
            className={
              mode
                ? 'aspect-[4/3] max-h-[42dvh] w-full lg:max-h-none'
                : 'aspect-[3/4] max-h-[64dvh] w-full sm:aspect-[4/3] lg:aspect-[4/3.4] lg:max-h-none'
            }
          />
          {/* Over the live picture (HUD); under the viewfinder while the camera is off. */}
          {!mode && latest && (
            <div className={live ? 'absolute inset-x-3 bottom-3 z-20' : 'mt-3'} aria-live="polite">
              <ScanResult key={latest.id} result={latest.result} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {modeNode}

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

          {householdId && mode && (mode === 'fill' || mode === 'put') && <CouldntSync householdId={householdId} />}

          {!mode && (
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
                        {h.result.status === 'place'
                          ? h.result.place.path
                          : h.result.status === 'product'
                            ? h.result.product.name
                            : h.result.status === 'asset'
                              ? h.result.asset.name
                              : t(`scan.short.${h.result.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
