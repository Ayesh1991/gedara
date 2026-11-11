// Pantry › Bin scanner (Phase 11): what the scanner by the kitchen bin did. "Needs you" on top
// (barcodes to link once, Add right after a bill, scans kept while paused), then the recent scans,
// each with Undo. Everything arrives live over Realtime; nothing polls.
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ScanBarcode, Settings, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/aurora/EmptyState';
import { usePantry } from '@/components/pantry/bits';
import { ScanCard } from '@/components/scanner/ScanCard';
import { scannerPopupsEnabled, setScannerPopupsEnabled } from '@/components/scanner/ScannerPopups';
import { useScannerLive } from '@/components/scanner/useScannerLive';
import { Card } from '@/components/ui/card';
import { scannerOnline } from '@/lib/scanner/format';
import { scannersQuery, scansQuery, waitingScansQuery, type BinScan } from '@/lib/scanner/queries';

export const Route = createFileRoute('/_app/pantry/scanner')({
  component: BinScannerPage,
});

function BinScannerPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const scanners = useQuery(scannersQuery(householdId));
  const recent = useQuery(scansQuery(householdId, { limit: 40 }));
  const waiting = useQuery(waitingScansQuery(householdId));
  const { barcodes, products } = usePantry(householdId);
  const [popups, setPopups] = useState(scannerPopupsEnabled);
  useScannerLive(householdId);

  const time = new Intl.DateTimeFormat(membership.household.locale, { dateStyle: 'short', timeStyle: 'short', timeZone: membership.household.timezone });
  const active = (scanners.data ?? []).filter((d) => !d.revoked_at);

  // One card per unknown code (the oldest scan of it), with how many are waiting behind it.
  const needs = useMemo(() => {
    const list = waiting.data ?? [];
    const sameCode = new Map<string, number>();
    for (const s of list) if (s.status === 'unknown' && s.code) sameCode.set(s.code, (sameCode.get(s.code) ?? 0) + 1);
    const seen = new Set<string>();
    const out: { scan: BinScan; count: number }[] = [];
    for (const s of list) {
      if (s.status === 'unknown' && s.code) {
        if (seen.has(s.code)) continue;
        seen.add(s.code);
        out.push({ scan: s, count: sameCode.get(s.code) ?? 1 });
      } else {
        out.push({ scan: s, count: 1 });
      }
    }
    return out;
  }, [waiting.data]);

  // A waiting barcode that has been linked meanwhile (e.g. through the new-product form): offer "Apply".
  const linkedName = (code: string | null): string | null => {
    if (!code) return null;
    const b = (barcodes.data ?? []).find((x) => x.barcode === code);
    return b ? ((products.data ?? []).find((p) => p.id === b.product_id)?.name ?? null) : null;
  };

  const waitingIds = new Set((waiting.data ?? []).map((s) => s.id));
  const history = (recent.data ?? []).filter((s) => !waitingIds.has(s.id));

  return (
    <div className="flex flex-col gap-5">
      <Link to="/pantry" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.pantry')}
      </Link>
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="flex-1 font-display text-[30px] font-semibold tracking-tight">{t('scanner.page.title')}</h1>
        <label className="flex items-center gap-2 text-[13.5px] text-muted">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent-a)]"
            checked={popups}
            onChange={(e) => {
              setPopups(e.target.checked);
              setScannerPopupsEnabled(e.target.checked);
            }}
          />
          {t('scanner.page.popups')}
        </label>
      </div>

      {scanners.isPending ? (
        <div className="glass h-28 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : active.length === 0 ? (
        <EmptyState
          icon={ScanBarcode}
          title={t('scanner.page.emptyTitle')}
          body={t('scanner.page.emptyBody')}
          action={
            <Link to="/settings/devices" className="text-accent-b underline">
              {t('scanner.page.addScanner')}
            </Link>
          }
        />
      ) : (
        <Card className="flex flex-col divide-y divide-line p-0">
          {active.map((d) => {
            const online = scannerOnline(d.last_seen_at);
            return (
              <Link
                key={d.id}
                to="/settings/scanner/$deviceId"
                params={{ deviceId: d.id }}
                className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03]"
                data-testid="scanner-device-row"
              >
                {d.paused_at ? <TriangleAlert className="h-5 w-5 shrink-0 text-caution" aria-hidden /> : <ScanBarcode className="h-5 w-5 shrink-0 text-muted" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className={`text-[12.5px] ${d.paused_at ? 'text-caution' : 'text-muted'}`}>
                    {d.paused_at
                      ? t(`scanner.pause.reasons.${d.paused_reason ?? 'manual'}`)
                      : d.last_seen_at
                        ? t('scanner.page.seen', { seen: time.format(new Date(d.last_seen_at)) })
                        : t('scanner.devices.notYet')}
                  </div>
                </div>
                <span className={`text-[12.5px] ${d.paused_at ? 'text-caution' : online ? 'text-teal' : 'text-faint'}`}>
                  {t(d.paused_at ? 'scanner.devices.paused' : online ? 'scanner.devices.online' : 'scanner.devices.offline')}
                </span>
                <Settings className="h-4 w-4 text-faint" aria-hidden />
              </Link>
            );
          })}
        </Card>
      )}

      {needs.length > 0 && (
        <section className="flex flex-col gap-2.5" data-testid="scanner-needs">
          <h2 className="font-display text-[19px] font-semibold">
            {t('scanner.page.needsYou')} <span className="tabular text-muted">{needs.length}</span>
          </h2>
          {needs.map(({ scan, count }) => (
            <ScanCard
              key={scan.id}
              scan={scan}
              householdId={householdId}
              canWrite={canWrite}
              waitingSame={count}
              linkedTo={scan.status === 'unknown' ? linkedName(scan.code) : null}
              when={time.format(new Date(scan.at))}
            />
          ))}
        </section>
      )}

      {active.length > 0 && (
        <section className="flex flex-col gap-2.5" data-testid="scanner-recent">
          <h2 className="font-display text-[19px] font-semibold">{t('scanner.page.recent')}</h2>
          {recent.isPending ? (
            <div className="glass h-24 animate-pulse rounded-[var(--r)]" aria-hidden />
          ) : history.length === 0 ? (
            <p className="text-[14px] text-muted">{t('scanner.page.noScans')}</p>
          ) : (
            history.map((s) => <ScanCard key={s.id} scan={s} householdId={householdId} canWrite={canWrite} when={time.format(new Date(s.at))} />)
          )}
        </section>
      )}

      <p className="text-[12.5px] text-faint">{t('scanner.page.keysHint')}</p>
    </div>
  );
}
