import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleAlert, Info, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProductScanCard, UnknownBarcodeCard } from '@/components/pantry/ScanCards';
import { ClimateChip, KindChip, PlaceArt } from '@/components/places/PlaceVisuals';
import { AssetArt, StatusBadge } from '@/components/things/bits';
import { placePhotosQuery, placesQuery } from '@/lib/places';
import { assetPhotosQuery } from '@/lib/things/queries';
import { assetTag } from '@/lib/things/value';
import type { Resolved } from '@/lib/resolve';
import { cn } from '@/lib/utils';

/**
 * The card that slides up after a scan (HUD) or pops up as a toast (USB scanner anywhere; `compact`:
 * no sheets inside a toast that disappears).
 */
export function ScanResult({
  result,
  onNavigate,
  className,
  compact,
}: {
  result: Resolved;
  onNavigate?: () => void;
  className?: string;
  compact?: boolean;
}) {
  if (result.status === 'place') return <PlaceResult result={result} onNavigate={onNavigate} className={className} />;
  if (result.status === 'asset') return <AssetResult result={result} onNavigate={onNavigate} className={className} />;
  if (result.status === 'product') {
    return <ProductScanCard result={result} compact={compact} onNavigate={onNavigate} className={className} />;
  }
  if (result.status === 'unknownBarcode') {
    return <UnknownBarcodeCard code={result.code} compact={compact} onNavigate={onNavigate} className={className} />;
  }
  return <MessageResult result={result} className={className} />;
}

function MessageResult({
  result,
  className,
}: {
  result: Extract<Resolved, { status: 'notFound' | 'invalid' | 'later' | 'grocy' }>;
  className?: string;
}) {
  const { t } = useTranslation();
  const later = result.status === 'later' || result.status === 'grocy';
  return (
    <div className={cn('glass-strong slide-up flex items-start gap-3 rounded-3xl p-4', className)} role="status" data-testid="scan-result">
      {later ? (
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-caution" aria-hidden />
      )}
      <div className="min-w-0">
        <div className="font-display font-semibold">
          {result.status === 'later' ? t('scan.later.title', { phase: result.phase }) : t(`scan.${result.status}.title`)}
        </div>
        <div className="tabular mt-0.5 truncate text-[12.5px] text-muted">
          {result.status === 'notFound'
            ? result.code
            : result.status === 'invalid'
              ? result.raw
              : result.status === 'grocy'
                ? t('scan.grocy.body')
                : t('scan.later.lot')}
        </div>
      </div>
    </div>
  );
}

function PlaceResult({
  result,
  onNavigate,
  className,
}: {
  result: Extract<Resolved, { status: 'place' }>;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const householdId = result.place.household_id;
  const places = useQuery(placesQuery(householdId));
  const photos = useQuery(placePhotosQuery(householdId));
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

function AssetResult({
  result,
  onNavigate,
  className,
}: {
  result: Extract<Resolved, { status: 'asset' }>;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { asset } = result;
  const places = useQuery(placesQuery(asset.household_id));
  const photos = useQuery(assetPhotosQuery(asset.household_id));
  const place = asset.location_id ? places.data?.find((p) => p.id === asset.location_id) : undefined;

  return (
    <div className={cn('glass-strong slide-up flex flex-col gap-3 rounded-3xl p-3.5', className)} role="status" data-testid="scan-result">
      <div className="flex items-center gap-3.5">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
          <AssetArt name={asset.name} photo={photos.data?.get(asset.id)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-muted">{place?.path ?? t('things.noPlace')}</div>
          <div className="truncate font-display text-[18px] font-semibold">{asset.name}</div>
          <div className="tabular text-[11.5px] text-accent-b">{assetTag(asset.asset_no)}</div>
        </div>
        <StatusBadge status={asset.status} />
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Link
          to="/things/$assetId"
          params={{ assetId: asset.id }}
          onClick={onNavigate}
          className="accent-pill flex h-11 items-center justify-center gap-1.5 rounded-[14px] font-display text-[15px] font-semibold"
        >
          {t('scan.open')}
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          to="/places/labels"
          search={{ assets: asset.id }}
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
