import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarList } from '@/components/insights/charts';
import { locationContentsQuery } from '@/lib/insights/queries';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, lkr } from './common';

/** Places: what each place holds and is worth; places where nothing moved for a year (declutter). */
export function PlacesArea({ membership }: AreaProps) {
  const { t } = useTranslation();
  const places = useQuery(locationContentsQuery(membership.household.id));
  if (places.isError) return <LoadError />;
  if (!places.data) return <Loading />;
  const used = places.data.filter((p) => p.lots + p.assets > 0);
  const stale = places.data.filter((p) => p.stale_lots + p.stale_assets > 0);
  const placeTo = (id: string) => ({ to: '/places/$placeId', params: { placeId: id } });

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('insights.places.value')}>
        {used.length === 0 ? (
          <Empty>{t('insights.places.empty')}</Empty>
        ) : (
          <BarList
            label={t('insights.places.value')}
            format={lkr}
            rows={used
              .map((p) => ({ p, v: p.stock_value + p.asset_value }))
              .sort((a, b) => b.v - a.v)
              .map(({ p, v }) => ({
                key: p.location_id,
                label: p.path,
                sub: t('insights.places.holds', { lots: p.lots, assets: p.assets }),
                value: v,
                to: placeTo(p.location_id),
              }))}
          />
        )}
      </Section>
      <Section title={t('insights.places.stale')}>
        {stale.length === 0 ? (
          <Empty>{t('insights.places.staleEmpty')}</Empty>
        ) : (
          <BarList
            label={t('insights.places.stale')}
            format={(v) => String(v)}
            rows={stale.map((p) => ({
              key: p.location_id,
              label: p.path,
              value: p.stale_lots + p.stale_assets,
              valueText: t('insights.places.staleCount', { count: p.stale_lots + p.stale_assets }),
              to: placeTo(p.location_id),
            }))}
          />
        )}
      </Section>
    </div>
  );
}
