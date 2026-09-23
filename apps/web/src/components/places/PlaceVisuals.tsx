import {
  Archive,
  Box,
  Car,
  DoorOpen,
  Droplets,
  LayoutGrid,
  LibraryBig,
  MapPin,
  Snowflake,
  Sofa,
  Sun,
  Thermometer,
  ThermometerSnowflake,
  Warehouse,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { createElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Climate, PlaceKind, PlacePhoto } from '@/lib/places';
import { qrSvgPath, rawCodeQr } from '@/lib/qr';
import { cn } from '@/lib/utils';

export const KIND_ICON: Record<PlaceKind, LucideIcon> = {
  room: DoorOpen,
  furniture: Sofa,
  container: Box,
  drawer: Archive,
  shelf: LibraryBig,
  zone: LayoutGrid,
  vehicle: Car,
  offsite: Warehouse,
};

export const CLIMATE_ICON: Record<Climate, LucideIcon> = {
  ambient: Thermometer,
  fridge: ThermometerSnowflake,
  freezer: Snowflake,
  dry: Sun,
  humid: Droplets,
};

export function kindIcon(kind: string | null): LucideIcon {
  return (kind && KIND_ICON[kind as PlaceKind]) || MapPin;
}

/** The icon for a place kind (MapPin when unset). */
export function KindIcon({ kind, ...props }: { kind: string | null } & LucideProps) {
  return createElement(kindIcon(kind), props);
}

/** Photo thumbnail, or an aurora gradient with the kind icon + initial when there's no photo. */
export function PlaceArt({
  name,
  kind,
  photo,
  size = 'tile',
  className,
}: {
  name: string;
  kind: string | null;
  photo?: PlacePhoto | null;
  size?: 'tile' | 'hero' | 'thumb';
  className?: string;
}) {
  const url = size === 'hero' ? (photo?.fullUrl ?? photo?.thumbUrl) : photo?.thumbUrl;
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn('h-full w-full object-cover', className)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn('relative flex h-full w-full items-center justify-center overflow-hidden', className)}
      style={{
        background:
          'radial-gradient(120% 90% at 20% 10%, color-mix(in srgb, var(--accent-a) 42%, transparent), transparent 60%), radial-gradient(90% 80% at 90% 100%, color-mix(in srgb, var(--accent-b) 32%, transparent), transparent 65%), var(--panel)',
      }}
    >
      <span
        className={cn(
          'font-display font-bold text-white/[0.09] select-none',
          size === 'thumb' ? 'text-2xl' : 'text-[88px] leading-none',
        )}
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <KindIcon
        kind={kind}
        className={cn('absolute text-white/80', size === 'thumb' ? 'h-5 w-5' : 'h-9 w-9')}
        strokeWidth={1.6}
      />
    </div>
  );
}

export function Chip({ icon: Icon, children, tone = 'neutral' }: { icon?: LucideIcon; children: string; tone?: 'neutral' | 'info' }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px]',
        tone === 'info' ? 'bg-info/12 text-info' : 'bg-white/[0.06] text-[#c5cce3]',
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />}
      {children}
    </span>
  );
}

export function KindChip({ kind }: { kind: string | null }) {
  const { t } = useTranslation();
  if (!kind) return null;
  return <Chip icon={KIND_ICON[kind as PlaceKind] ?? MapPin}>{t(`places.kinds.${kind as PlaceKind}`)}</Chip>;
}

export function ClimateChip({ climate }: { climate: string | null }) {
  const { t } = useTranslation();
  if (!climate) return null;
  return (
    <Chip icon={CLIMATE_ICON[climate as Climate]} tone="info">
      {t(`places.climates.${climate as Climate}`)}
    </Chip>
  );
}

/** Raw-code QR (version 1-M) exactly as the 20 mm label will carry it. */
export function CodeQr({ code, className }: { code: string; className?: string }) {
  const path = useMemo(() => {
    try {
      return qrSvgPath(rawCodeQr(code));
    } catch {
      return '';
    }
  }, [code]);
  return (
    <svg
      viewBox="-2 -2 25 25"
      shapeRendering="crispEdges"
      role="img"
      aria-label={code}
      className={cn('rounded-lg bg-white', className)}
    >
      <path d={path} fill="#05070F" />
    </svg>
  );
}
