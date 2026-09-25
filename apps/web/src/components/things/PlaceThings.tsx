import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { todayIn } from '@/lib/time';
import { AssetForm } from './AssetForm';
import { AssetCard } from './AssetViews';
import { useThings } from './bits';

/** "What's in this room / box" for Things (MASTER_PLAN §4 #2): the things kept here, with photos. */
export function PlaceThings({
  householdId,
  placeId,
  timezone,
  locale,
  canWrite,
}: {
  householdId: string;
  placeId: string;
  timezone: string;
  locale: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const things = useThings(householdId);
  const [adding, setAdding] = useState(false);
  const today = todayIn(timezone);
  const here = (things.assets.data ?? []).filter((a) => a.location_id === placeId && !['sold', 'disposed', 'lost'].includes(a.status));

  return (
    <section className="flex flex-col gap-3" data-testid="place-things">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-[19px] font-semibold">
          {t('nav.things')} <span className="tabular text-[14px] text-muted">{here.length || ''}</span>
        </h2>
        {canWrite && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('things.addHere')}
          </Button>
        )}
      </div>
      {!things.ready ? (
        <div className="glass h-24 animate-pulse rounded-2xl" aria-hidden />
      ) : here.length === 0 ? (
        <p className="text-[14px] text-[#a5b0d0]">{t('things.placeEmpty')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
          {here.map((a) => (
            <AssetCard key={a.id} asset={a} photo={things.photos.data?.get(a.id)} today={today} />
          ))}
        </div>
      )}
      {things.categories.data && (
        <AssetForm
          open={adding}
          onClose={() => setAdding(false)}
          householdId={householdId}
          locale={locale}
          categories={things.categories.data}
          tree={things.tree}
          assets={things.assets.data ?? []}
          tags={things.tags.data ?? []}
          fields={things.fields.data ?? []}
          initial={{ location_id: placeId }}
        />
      )}
    </section>
  );
}
