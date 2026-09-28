import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Archive, ArchiveRestore, ChevronLeft, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PlaceTypeSheet } from '@/components/places/PlaceTypeSheet';
import { KIND_ICON, kindIcon } from '@/components/places/PlaceVisuals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PLACE_KINDS, placeTypesKey, placeTypesQuery, updatePlaceType, type PlaceType } from '@/lib/places';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/place-types')({
  component: PlaceTypesPage,
});

/** Place types: the built-in kinds (fixed) and the household's own (Phase 7d): rename, icon, archive. */
function PlaceTypesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const types = useQuery(placeTypesQuery(householdId));
  const [editing, setEditing] = useState<PlaceType | 'new' | null>(null);

  async function archive(x: PlaceType) {
    try {
      await updatePlaceType(x.id, { archived: !x.archived });
      await qc.invalidateQueries({ queryKey: placeTypesKey(householdId) });
    } catch {
      toast.error(t('placeTypes.errors.generic'));
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <Link to="/settings" className="-mb-2 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('placeTypes.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('placeTypes.intro')}</p>
      </div>

      <Card className="flex flex-col gap-3 p-5" data-testid="own-place-types">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-[17px] font-semibold">{t('placeTypes.yours')}</h2>
          {canWrite && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('placeTypes.new')}
            </Button>
          )}
        </div>
        {!types.data?.length ? (
          <p className="text-[13.5px] text-muted">{t('placeTypes.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {types.data.map((x) => {
              const Icon = kindIcon(null, x);
              return (
                <li key={x.id} className={cn('flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-2', x.archived && 'opacity-60')}>
                  <Icon className="h-[18px] w-[18px] shrink-0 text-accent-b" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">
                    {x.name}
                    {x.archived && <span className="text-[12px] text-muted"> · {t('placeTypes.archived')}</span>}
                  </span>
                  {canWrite && (
                    <>
                      <Button size="icon" variant="ghost" aria-label={t('placeTypes.edit', { name: x.name })} onClick={() => setEditing(x)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t(x.archived ? 'placeTypes.restore' : 'placeTypes.archive', { name: x.name })}
                        onClick={() => void archive(x)}
                      >
                        {x.archived ? <ArchiveRestore className="h-4 w-4" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />}
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[12.5px] text-muted">{t('placeTypes.archiveHint')}</p>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="font-display text-[17px] font-semibold">{t('placeTypes.builtIn')}</h2>
        <div className="flex flex-wrap gap-2">
          {PLACE_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <span key={k} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-[13.5px] text-[#c5cce3]">
                <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
                {t(`places.kinds.${k}`)}
              </span>
            );
          })}
        </div>
      </Card>

      <PlaceTypeSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        householdId={householdId}
        type={editing === 'new' ? null : editing}
      />
    </div>
  );
}
