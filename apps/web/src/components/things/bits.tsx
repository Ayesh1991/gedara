import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlaces } from '@/components/places/PlaceGrid';
import { accountsQuery, categoriesQuery } from '@/lib/money/queries';
import type { EntityPhoto } from '@/lib/photos';
import {
  assetPhotosQuery,
  assetsQuery,
  fieldsQuery,
  pendingLinesQuery,
  tagsQuery,
  type AssetStatus,
} from '@/lib/things/queries';
import { WARRANTY_TONE, warrantyState } from '@/lib/things/value';
import { cn } from '@/lib/utils';

export { fieldLabel, selectClass } from '@/components/money/bits';

/** Everything the Things screens share. */
export function useThings(householdId: string) {
  const assets = useQuery(assetsQuery(householdId));
  const photos = useQuery(assetPhotosQuery(householdId));
  const pending = useQuery(pendingLinesQuery(householdId));
  const tags = useQuery(tagsQuery(householdId));
  const fields = useQuery(fieldsQuery(householdId));
  const categories = useQuery(categoriesQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId));
  const { places, tree } = usePlaces(householdId);
  return {
    assets,
    photos,
    pending,
    tags,
    fields,
    categories,
    accounts,
    places,
    tree,
    ready: assets.isSuccess && categories.isSuccess,
    error: assets.isError,
  };
}

/** Photo, or a gradient tile with the initial. */
export function AssetArt({ name, photo, className }: { name: string; photo?: EntityPhoto | null; className?: string }) {
  if (photo?.thumbUrl) {
    return <img src={photo.thumbUrl} alt="" loading="lazy" className={cn('h-full w-full object-cover', className)} />;
  }
  return (
    <div
      className={cn('flex h-full w-full items-center justify-center', className)}
      style={{
        background:
          'linear-gradient(145deg, color-mix(in srgb, var(--accent-b) 26%, transparent), color-mix(in srgb, var(--accent-a) 16%, transparent))',
      }}
      aria-hidden
    >
      <span className="font-display text-[22px] font-semibold text-text/90">{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

const STATUS_TONE: Record<AssetStatus, string> = {
  in_use: '',
  stored: 'bg-white/10 text-muted',
  lent: 'bg-info/15 text-info',
  in_repair: 'bg-due/15 text-due',
  sold: 'bg-white/10 text-muted',
  disposed: 'bg-white/10 text-muted',
  lost: 'bg-red/15 text-red',
};

/** Status chip; nothing for "in use" (the normal case). */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const tone = STATUS_TONE[status as AssetStatus];
  if (!tone) return null;
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', tone)}>
      {t(`things.status.${status as AssetStatus}`)}
    </span>
  );
}

/** "Warranty · 21 days" in amber, "Warranty to 12 Mar 2028" in teal, "Lifetime warranty". */
export function WarrantyBadge({
  asset,
  today,
  long,
}: {
  asset: { lifetime_warranty: boolean; warranty_until: string | null; status: string };
  today: string;
  long?: boolean;
}) {
  const { t } = useTranslation();
  if (['sold', 'disposed', 'lost'].includes(asset.status)) return null;
  const w = warrantyState(asset, today);
  if (w.state === 'none' || (w.state === 'expired' && !long)) return null;
  const text =
    w.state === 'lifetime'
      ? t('things.warranty.lifetime')
      : w.state === 'expired'
        ? t('things.warranty.expired')
        : w.state === 'ending'
          ? t('things.warranty.ending', { count: w.daysLeft ?? 0 })
          : long
            ? t('things.warranty.until', { date: asset.warranty_until })
            : t('things.warranty.short');
  return (
    <span className={cn('tabular rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', WARRANTY_TONE[w.state])}>
      {text}
    </span>
  );
}

export function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <div className="flex items-center gap-3">
        <h2 id={id} className="flex-1 font-display text-[19px] font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function IconAction({
  label,
  onClick,
  icon: Icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: LucideIcon;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'glass flex h-14 min-w-[4.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11.5px] sm:h-11 sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:text-[14px]',
        danger ? 'text-red' : 'text-[#c5cce3]',
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export const textareaClass =
  'w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[16px] text-text focus:border-accent-a focus:outline-none';
