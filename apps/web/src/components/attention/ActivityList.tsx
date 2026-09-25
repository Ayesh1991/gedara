import { useTranslation } from 'react-i18next';
import { TargetLink } from '@/components/insights/Num';
import type { Target } from '@/lib/attention';
import type { ActivityRow } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';

/** Where a timeline entry leads (null = the record is gone). */
export function activityTarget(a: ActivityRow): Target | null {
  const p = a.payload;
  switch (a.entity_type) {
    case 'transaction':
      return a.verb === 'deleted' ? null : { to: '/money/tx/$txId', params: { txId: a.entity_id } };
    case 'stock': {
      const ids = Array.isArray(p.product_ids) ? (p.product_ids as string[]) : [];
      return ids.length === 1 ? { to: '/pantry/$productId', params: { productId: ids[0]! } } : { to: '/pantry/journal' };
    }
    case 'asset':
      return { to: '/things/$assetId', params: { assetId: a.entity_id } };
    case 'maintenance':
      return typeof p.asset_id === 'string' ? { to: '/things/$assetId', params: { assetId: p.asset_id } } : null;
    case 'product':
      return { to: '/pantry/$productId', params: { productId: a.entity_id } };
    case 'location':
      return { to: '/places/$placeId', params: { placeId: a.entity_id } };
    default:
      return null;
  }
}

function relative(at: string, locale: string, now = Date.now()): string {
  const s = Math.round((Date.parse(at) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

/** The household timeline (Home "Recent activity"): who did what, newest first, each linking to it. */
export function ActivityList({ rows, locale }: { rows: ActivityRow[]; locale: string }) {
  const { t } = useTranslation();
  const text = (a: ActivityRow) => {
    const p = a.payload;
    const name = a.summary ?? '';
    const more = Array.isArray(p.product_ids) && p.product_ids.length > 1 ? p.product_ids.length - 1 : 0;
    const known = ['transaction', 'stock', 'asset', 'maintenance', 'product', 'location'].includes(a.entity_type);
    const key = known ? `activity.${a.entity_type}.${a.verb}` : 'activity.other';
    const total = typeof p.total === 'number' ? formatLKR(p.total, { whole: true }) : '';
    const s = t(key as 'activity.other', { name, count: more, total, defaultValue: t('activity.other', { name }) });
    return more > 0 ? `${s} ${t('activity.more', { count: more })}` : s;
  };
  return (
    <ol className="flex flex-col">
      {rows.map((a, i) => {
        const target = activityTarget(a);
        const body = (
          <>
            <span className="flex flex-col items-center self-stretch pt-1.5" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full border-2 border-accent-b" />
              {i < rows.length - 1 && <span className="mt-1 w-0.5 flex-1 bg-white/10" />}
            </span>
            <span className="min-w-0 flex-1 pb-3">
              <span className="block truncate text-[14px]">{text(a)}</span>
              <span className="block truncate text-[12px] text-muted">
                {[a.actor_name, relative(a.at, locale)].filter(Boolean).join(' · ')}
              </span>
            </span>
          </>
        );
        return (
          <li key={a.id}>
            {target ? (
              <TargetLink target={target} className="flex gap-3 rounded-xl px-1 hover:bg-white/[0.03]">
                {body}
              </TargetLink>
            ) : (
              <div className="flex gap-3 px-1">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
