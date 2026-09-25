import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { formatBytes } from '@/lib/files';
import { storageUsageQuery } from '@/lib/things/queries';

export const Route = createFileRoute('/_app/settings/storage')({
  component: StoragePage,
});

/** Supabase's free plan: 1 GB of file storage per project (MASTER_PLAN §7e). */
const PLAN_BYTES = 1024 ** 3;
/** Past this, it's time to set up the Google Drive overflow (deferred on 2026-09-25). */
const DRIVE_AT = 0.7;

/** Settings › Storage: how much the household's photos and documents take. */
function StoragePage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const usage = useQuery(storageUsageQuery(householdId));

  const rows = usage.data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.bytes ?? 0), 0);
  const files = rows.reduce((s, r) => s + Number(r.files ?? 0), 0);
  // Thumbnails aren't counted in `bytes`; they're about 20 % on top of the full-size photos.
  const estimate = Math.round(total * 1.2);
  const share = Math.min(1, estimate / PLAN_BYTES);
  const byKind = new Map<string, { files: number; bytes: number }>();
  for (const r of rows) {
    const k = r.kind ?? 'other';
    const v = byKind.get(k) ?? { files: 0, bytes: 0 };
    v.files += Number(r.files ?? 0);
    v.bytes += Number(r.bytes ?? 0);
    byKind.set(k, v);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/settings" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('settings.title')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('storage.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('storage.intro')}</p>
      </div>

      {usage.isPending ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : usage.isError ? (
        <Card className="text-[14px] text-red">{t('storage.loadError')}</Card>
      ) : (
        <>
          <Card className="flex flex-col gap-3" data-testid="storage-usage">
            <div className="flex items-baseline justify-between gap-3">
              <span className="tabular text-[26px] font-semibold">{formatBytes(estimate, locale) || '0 KB'}</span>
              <span className="tabular text-[13px] text-muted">{t('storage.ofPlan', { plan: formatBytes(PLAN_BYTES, locale) })}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t('storage.title')}>
              <div
                className={share >= DRIVE_AT ? 'h-full rounded-full bg-caution' : 'h-full rounded-full'}
                style={{
                  width: `${Math.max(share * 100, estimate > 0 ? 1 : 0)}%`,
                  background: share >= DRIVE_AT ? undefined : 'linear-gradient(90deg, var(--accent-a), var(--accent-b))',
                }}
              />
            </div>
            <p className="tabular text-[13px] text-muted">{t('storage.files', { count: files })}</p>
            <p className="text-[13px] text-[#a5b0d0]">{share >= DRIVE_AT ? t('storage.nearlyFull') : t('storage.driveLater')}</p>
          </Card>

          {byKind.size > 0 && (
            <Card className="p-0">
              <ul className="divide-y divide-line">
                {[...byKind.entries()]
                  .sort((a, b) => b[1].bytes - a[1].bytes)
                  .map(([kind, v]) => (
                    <li key={kind} className="flex items-center gap-3 px-5 py-3 text-[14.5px]">
                      <span className="flex-1">{t(`things.docs.kinds.${kind as 'photo'}`)}</span>
                      <span className="tabular text-[13px] text-muted">{t('storage.files', { count: v.files })}</span>
                      <span className="tabular w-20 text-right">{formatBytes(v.bytes, locale)}</span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
