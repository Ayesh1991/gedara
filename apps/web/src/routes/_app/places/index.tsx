import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ListChecks, Map as MapIcon, MapPin, Plus, Printer, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlaceForm } from '@/components/places/PlaceForm';
import { PlaceGrid, PlacesSkeleton, usePlaces } from '@/components/places/PlaceGrid';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { childrenOf } from '@/lib/tree';

export const Route = createFileRoute('/_app/places/')({
  component: PlacesPage,
});

/** Places explorer (MASTER_PLAN §5.2): top-level rooms; drill in; select many → print labels. */
function PlacesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const { places, photos, tree } = usePlaces(householdId);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const top = childrenOf(tree, null);
  const total = places.data?.length ?? 0;
  const rooms = places.data?.filter((p) => p.kind === 'room').length ?? 0;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.places')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('places.intro')}</p>
        </div>
        <div className="flex gap-2.5">
          <Link to="/places/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            <MapIcon className="h-4 w-4" aria-hidden />
            {t('plan.short')}
          </Link>
          {total > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelecting((s) => !s);
                setSelected(new Set());
              }}
            >
              {selecting ? <X className="h-4 w-4" aria-hidden /> : <ListChecks className="h-4 w-4" aria-hidden />}
              {selecting ? t('common.cancel') : t('places.select')}
            </Button>
          )}
          {canWrite && !selecting && (
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('places.addPlace')}
            </Button>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="grid grid-cols-3 gap-2.5 sm:flex sm:flex-wrap">
          {[
            { label: t('places.stats.places', { count: total }), value: total },
            { label: t('places.stats.rooms', { count: rooms }), value: rooms },
            { label: t('places.stats.photos', { count: photos?.size ?? 0 }), value: photos?.size ?? 0 },
          ].map((s) => (
            <div key={s.label} className="glass flex flex-col rounded-2xl px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-2 sm:px-4">
              <span className="tabular text-[20px] font-medium">{s.value}</span>
              <span className="truncate text-[12.5px] text-muted">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {places.isPending ? (
        <PlacesSkeleton />
      ) : places.isError ? (
        <Card className="text-[14px] text-red">{t('places.loadError')}</Card>
      ) : total === 0 ? (
        <Card className="relative flex flex-col items-center gap-4 overflow-hidden px-6 py-10 text-center">
          <div
            aria-hidden
            className="absolute -top-20 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full opacity-40 blur-3xl"
            style={{ background: 'var(--glow)' }}
          />
          <div className="brand-gradient relative flex h-16 w-16 items-center justify-center rounded-3xl text-[#05070F]">
            <MapPin className="h-8 w-8" aria-hidden />
          </div>
          <div className="relative max-w-md">
            <h2 className="font-display text-[20px] font-semibold">{t('places.emptyTitle')}</h2>
            <p className="mt-1.5 text-[14.5px] leading-relaxed text-[#a5b0d0]">{t('places.emptyBody')}</p>
          </div>
          {canWrite && (
            <Button variant="primary" className="relative" onClick={() => setAdding(true)}>
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              {t('places.addFirst')}
            </Button>
          )}
        </Card>
      ) : (
        <PlaceGrid
          items={selecting ? [...tree.byId.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })) : top}
          tree={tree}
          photos={photos}
          selecting={selecting}
          selected={selected}
          onToggle={toggle}
        />
      )}

      {selecting && (
        <div className="sticky bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+1.75rem)] z-20 lg:bottom-6">
          <div className="glass-strong slide-up mx-auto flex max-w-md items-center gap-3 rounded-3xl p-2.5 pl-4">
            <span className="tabular flex-1 text-[14px]">{t('places.selectedCount', { count: selected.size })}</span>
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => void navigate({ to: '/places/labels', search: { ids: [...selected].join(',') } })}
            >
              <Printer className="h-4 w-4" aria-hidden />
              {t('places.printLabels')}
            </Button>
          </div>
        </div>
      )}

      <PlaceForm open={adding} onClose={() => setAdding(false)} householdId={householdId} tree={tree} />
    </div>
  );
}
