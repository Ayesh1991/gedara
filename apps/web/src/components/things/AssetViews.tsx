import { Link } from '@tanstack/react-router';
import { ArrowRightLeft, HandCoins, Handshake, PackagePlus, Receipt, RotateCcw, Tag as TagIcon, Wrench, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Money } from '@/components/money/bits';
import type { EntityPhoto } from '@/lib/photos';
import type { Activity, Asset, AssetStatus, MaintenanceLog } from '@/lib/things/queries';
import { SERVICE_SOON_DAYS, daysBetween } from '@/lib/things/value';
import { formatDay } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AssetArt, StatusBadge, WarrantyBadge } from './bits';

/** "Service due in 3 days" / "Service overdue" (cyan = due, rule 11). */
export function DueChip({ nextDue, today }: { nextDue: string | null; today: string }) {
  const { t } = useTranslation();
  if (!nextDue) return null;
  const days = daysBetween(today, nextDue);
  if (days > SERVICE_SOON_DAYS) return null;
  return (
    <span className="tabular rounded-full bg-due/15 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-due">
      {days < 0 ? t('maintenance.overdue') : t('maintenance.dueIn', { count: days })}
    </span>
  );
}

/** Gallery tile: photo, A-tag, name, where it is, warranty / service / status chips. */
export function AssetCard({ asset, photo, today }: { asset: Asset; photo?: EntityPhoto | null; today: string }) {
  const gone = ['sold', 'disposed', 'lost'].includes(asset.status);
  return (
    <Link
      to="/things/$assetId"
      params={{ assetId: asset.id }}
      className={cn('glass group flex flex-col overflow-hidden rounded-[var(--r)] transition-transform active:scale-[0.99]', gone && 'opacity-60')}
      data-testid="asset-card"
    >
      <div className="relative aspect-[4/3] overflow-hidden">
        <AssetArt name={asset.name} photo={photo} className="text-[32px] transition-transform group-hover:scale-[1.02] motion-reduce:transition-none" />
        <span className="tabular absolute top-2 left-2 rounded-lg bg-black/55 px-1.5 py-0.5 text-[11px] text-white/90 backdrop-blur">
          {asset.tag}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="line-clamp-2 font-display text-[15.5px] leading-snug font-semibold">
          {asset.name}
          {asset.quantity > 1 && <span className="tabular text-muted"> ×{asset.quantity}</span>}
        </div>
        {asset.location_path && <div className="truncate text-[12px] text-muted">{asset.location_path}</div>}
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          <StatusBadge status={asset.status} />
          <WarrantyBadge asset={asset} today={today} />
          {!gone && <DueChip nextDue={asset.next_due} today={today} />}
        </div>
      </div>
    </Link>
  );
}

interface Entry {
  key: string;
  day: string;
  order: number;
  icon: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
}

/** Bought → moved → serviced → lent → sold, newest first (§5.2 Things "asset page with timeline"). */
export function AssetTimeline({
  asset,
  activity,
  logs,
  locale,
  timezone,
}: {
  asset: Asset;
  activity: Activity[];
  logs: MaintenanceLog[];
  locale: string;
  timezone: string;
}) {
  const { t } = useTranslation();
  const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
  const entries: Entry[] = [];

  if (asset.purchased_on) {
    entries.push({
      key: 'bought',
      day: asset.purchased_on,
      order: 0,
      icon: Receipt,
      title: asset.vendor ? t('things.timeline.boughtAt', { shop: asset.vendor }) : t('things.timeline.bought'),
      detail: (
        <>
          {asset.purchase_price !== null && <Money value={asset.purchase_price} />}
          {asset.bill_id && (
            <Link to="/money/tx/$txId" params={{ txId: asset.bill_id }} className="ml-2 text-accent-b">
              {t('things.timeline.bill')}
            </Link>
          )}
        </>
      ),
    });
  }

  for (const a of activity) {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const base = { key: `a${a.id}`, day: localDay(a.at), order: a.id };
    switch (a.verb) {
      case 'created':
        entries.push({ ...base, icon: PackagePlus, title: t('things.timeline.created') });
        break;
      case 'moved':
        entries.push({ ...base, icon: ArrowRightLeft, title: s(p.to_path) ? t('things.timeline.moved', { place: s(p.to_path) }) : t('things.timeline.movedNowhere') });
        break;
      case 'lent':
        entries.push({ ...base, icon: Handshake, title: t('things.timeline.lent', { name: s(p.lent_to) }) });
        break;
      case 'returned':
        entries.push({ ...base, icon: RotateCcw, title: t('things.timeline.returned', { name: s(p.lent_to) }) });
        break;
      case 'sold':
        entries.push({
          ...base,
          icon: HandCoins,
          title: s(p.sold_to) ? t('things.timeline.soldTo', { name: s(p.sold_to) }) : t('things.timeline.sold'),
          detail: typeof p.price === 'number' ? <Money value={p.price} tone /> : undefined,
        });
        break;
      case 'unsold':
        entries.push({ ...base, icon: RotateCcw, title: t('things.timeline.unsold') });
        break;
      default:
        entries.push({
          ...base,
          icon: TagIcon,
          title: t('things.timeline.status', { status: t(`things.status.${(s(p.to) || 'in_use') as AssetStatus}`) }),
        });
    }
  }

  for (const l of logs) {
    entries.push({
      key: `l${l.id}`,
      day: l.done_on,
      order: 1e12,
      icon: Wrench,
      title: l.title,
      detail: (
        <>
          {l.cost !== null && <Money value={l.cost} />}
          {l.vendor && <span className="ml-2 text-muted">{l.vendor}</span>}
          {l.transaction_id && (
            <Link to="/money/tx/$txId" params={{ txId: l.transaction_id }} className="ml-2 text-accent-b">
              {t('things.timeline.expense')}
            </Link>
          )}
        </>
      ),
    });
  }

  entries.sort((a, b) => (a.day === b.day ? b.order - a.order : a.day < b.day ? 1 : -1));
  if (!entries.length) return <p className="text-[14px] text-[#a5b0d0]">{t('things.timeline.empty')}</p>;

  return (
    <ol className="relative flex flex-col gap-3 border-l border-line pl-5" data-testid="timeline">
      {entries.map((e) => (
        <li key={e.key} className="relative">
          <span className="absolute top-0.5 -left-[31px] flex h-5 w-5 items-center justify-center rounded-full bg-[#0d1326] ring-1 ring-line-2">
            <e.icon className="h-3 w-3 text-accent-b" aria-hidden />
          </span>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14.5px]">{e.title}</span>
            <span className="tabular text-[12px] text-faint">{formatDay(e.day, locale)}</span>
          </div>
          {e.detail && <div className="tabular mt-0.5 text-[13px]">{e.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Small "Rs 12,000 · Rs 450 / month" style value line. */
export function ValueLine({ label, value, hint }: { label: string; value: number | null; hint?: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-[17px]">{value === null ? <span className="text-muted">—</span> : <Money value={value} />}</dd>
      {hint && <dd className="text-[12px] text-faint">{hint}</dd>}
    </div>
  );
}
