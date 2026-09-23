import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleAlert, Info, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ClimateChip, KindChip, PlaceArt } from '@/components/places/PlaceVisuals';
import { placePhotosQuery, placesQuery } from '@/lib/places';
import type { Resolved } from '@/lib/resolve';
import { cn } from '@/lib/utils';

/** The card that slides up after a scan (HUD) or pops up as a toast (USB scanner anywhere). */
export function ScanResult({ result, onNavigate, className }: { result: Resolved; onNavigate?: () => void; className?: string }) {
  const { t } = useTranslation();
  const householdId = result.status === 'place' ? result.place.household_id : '';
  const places = useQuery({ ...placesQuery(householdId), enabled: Boolean(householdId) });
  const photos = useQuery({ ...placePhotosQuery(householdId), enabled: Boolean(householdId) });

  if (result.status !== 'place') {
    const later = result.status === 'later';
    return (
      <div className={cn('glass-strong slide-up flex items-start gap-3 rounded-3xl p-4', className)} role="status" data-testid="scan-result">
        {later ? (
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
        ) : (
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-caution" aria-hidden />
        )}
        <div className="min-w-0">
          <div className="font-display font-semibold">
            {later ? t('scan.later.title', { phase: result.phase }) : t(`scan.${result.status}.title`)}
          </div>
          <div className="tabular mt-0.5 truncate text-[12.5px] text-muted">
            {result.status === 'notFound'
              ? result.code
              : result.status === 'invalid'
                ? result.raw
                : t(`scan.later.${result.parsed.kind === 'ast' ? 'asset' : 'pantry'}`)}
          </div>
        </div>
      </div>
    );
  }

  const { place } = result;
  const inside = places.data?.filter((p) => p.parent_id === place.id).length;
  const crumb = place.path.split(' › ').slice(0, -1).join(' › ');

  return (
    <div className={cn('glass-strong slide-up flex flex-col gap-3 rounded-3xl p-3.5', className)} role="status" data-testid="scan-result">
      <div className="flex items-center gap-3.5">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
          <PlaceArt name={place.name} kind={place.kind} photo={photos.data?.get(place.id)} size="thumb" />
        </div>
        <div className="min-w-0 flex-1">
          {crumb && <div className="truncate text-[12px] text-muted">{crumb}</div>}
          <div className="truncate font-display text-[18px] font-semibold">{place.name}</div>
          <div className="tabular text-[11.5px] text-accent-b">{place.code}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={place.kind} />
        <ClimateChip climate={place.climate} />
        {inside !== undefined && (
          <span className="tabular text-[12.5px] text-muted">{t('places.insideCount', { count: inside })}</span>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Link
          to="/places/$placeId"
          params={{ placeId: place.id }}
          onClick={onNavigate}
          className="accent-pill flex h-11 items-center justify-center gap-1.5 rounded-[14px] font-display text-[15px] font-semibold"
        >
          {t('scan.open')}
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          to="/places/labels"
          search={{ ids: place.id }}
          onClick={onNavigate}
          aria-label={t('places.printLabel')}
          className="glass flex h-11 w-11 items-center justify-center rounded-[14px]"
        >
          <Printer className="h-[18px] w-[18px]" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
