import { useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Copy, FolderInput, Pencil, Plus, Printer, Trash } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PlaceStock } from '@/components/pantry/PlaceStock';
import { PlaceThings } from '@/components/things/PlaceThings';
import { MoveSheet } from '@/components/places/MoveSheet';
import { PlaceForm } from '@/components/places/PlaceForm';
import { PlaceGrid, PlacesSkeleton, usePlaces } from '@/components/places/PlaceGrid';
import { ClimateChip, CodeQr, KindChip, PlaceArt } from '@/components/places/PlaceVisuals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { placeErrorKey, scheduleDelete } from '@/lib/places';
import { ancestors, childrenOf, descendants } from '@/lib/tree';

export const Route = createFileRoute('/_app/places/$placeId')({
  component: PlacePage,
});

function IconAction({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`glass flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] sm:h-11 sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:text-[14px] ${danger ? 'text-red' : 'text-[#c5cce3]'}`}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function PlacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { placeId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const { places, photos, tree } = usePlaces(householdId);
  const [sheet, setSheet] = useState<'edit' | 'add' | 'move' | null>(null);

  const place = tree.byId.get(placeId);

  if (places.isPending) return <PlacesSkeleton />;
  if (!place) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="font-display text-xl font-semibold">{t('places.notFoundTitle')}</h1>
        <p className="text-[14px] text-muted">{t('places.notFoundBody')}</p>
        <Link to="/places" className="text-sm text-accent-b underline">
          {t('places.backToPlaces')}
        </Link>
      </Card>
    );
  }

  const trail = ancestors(tree, place.id);
  const kids = childrenOf(tree, place.id);
  const everything = descendants(tree, place.id);
  const photo = photos?.get(place.id);

  function remove() {
    if (!place) return;
    if (kids.length) {
      toast.error(t('places.errors.hasChildren'));
      return;
    }
    const parent = place.parent_id;
    const { undo, ms } = scheduleDelete(qc, place, photo, (e) => toast.error(t(`places.errors.${placeErrorKey(e)}`)));
    toast(t('places.deleted', { name: place.name }), {
      duration: ms,
      action: { label: t('common.undo'), onClick: undo },
    });
    void navigate(parent ? { to: '/places/$placeId', params: { placeId: parent } } : { to: '/places' });
  }

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label={t('places.breadcrumb')} className="-mb-1 flex flex-wrap items-center gap-1 text-[13px] text-muted">
        <Link to="/places" className="hover:text-text">
          {t('nav.places')}
        </Link>
        {trail.map((a) => (
          <span key={a.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden />
            <Link to="/places/$placeId" params={{ placeId: a.id }} className="hover:text-text">
              {a.name}
            </Link>
          </span>
        ))}
      </nav>

      <Card className="relative overflow-hidden p-0">
        <div className="grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="relative aspect-[16/10] md:aspect-auto md:min-h-[300px]">
            <PlaceArt name={place.name} kind={place.kind} photo={photo} size="hero" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[rgba(5,7,15,0.7)] via-transparent to-transparent md:bg-gradient-to-r md:from-transparent md:via-transparent md:to-[rgba(5,7,15,0.35)]" />
          </div>
          <div className="flex flex-col gap-4 p-5 lg:p-6">
            <div>
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">{place.name}</h1>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <KindChip kind={place.kind} />
                <ClimateChip climate={place.climate} />
              </div>
            </div>
            <div className="flex items-center gap-3.5 rounded-2xl border border-line bg-white/[0.03] p-3">
              <CodeQr code={place.code} className="h-[72px] w-[72px] shrink-0 p-1" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-muted">{t('places.labelCode')}</div>
                <div className="tabular truncate text-[15px] text-accent-b">{place.code}</div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(place.code).then(() => toast.success(t('places.copied')));
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-text"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  {t('places.copyCode')}
                </button>
              </div>
            </div>
            {place.notes && <p className="text-[14px] leading-relaxed whitespace-pre-line text-[#c5cce3]">{place.notes}</p>}
            {canWrite && (
              <Button variant="primary" className="mt-auto w-full" onClick={() => setSheet('add')}>
                <Plus className="h-[18px] w-[18px]" aria-hidden />
                {t('places.addInside')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="flex gap-2 sm:flex-wrap">
        {canWrite && (
          <IconAction label={t('places.edit')} onClick={() => setSheet('edit')}>
            <Pencil className="h-[18px] w-[18px]" aria-hidden />
          </IconAction>
        )}
        {canWrite && (
          <IconAction label={t('places.move')} onClick={() => setSheet('move')}>
            <FolderInput className="h-[18px] w-[18px]" aria-hidden />
          </IconAction>
        )}
        <IconAction
          label={t('places.label')}
          onClick={() => void navigate({ to: '/places/labels', search: { ids: place.id } })}
        >
          <Printer className="h-[18px] w-[18px]" aria-hidden />
        </IconAction>
        {canWrite && (
          <IconAction label={t('places.delete')} onClick={remove} danger>
            <Trash className="h-[18px] w-[18px]" aria-hidden />
          </IconAction>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="flex-1 font-display text-[19px] font-semibold">
            {t('places.inside')} <span className="tabular text-[14px] text-muted">{kids.length}</span>
          </h2>
          {everything.length > 0 && (
            <Link
              to="/places/labels"
              search={{ ids: [place.id, ...everything.map((d) => d.id)].join(',') }}
              className="inline-flex items-center gap-1.5 text-[13.5px] text-accent-b"
            >
              <Printer className="h-4 w-4" aria-hidden />
              {t('places.printAllInside', { count: everything.length + 1 })}
            </Link>
          )}
        </div>
        {kids.length ? (
          <PlaceGrid items={kids} tree={tree} photos={photos} />
        ) : (
          <p className="text-[14px] text-[#a5b0d0]">{t('places.insideEmpty')}</p>
        )}
      </section>

      <PlaceStock
        householdId={householdId}
        placeId={place.id}
        timezone={membership.household.timezone}
        locale={membership.household.locale}
        canWrite={canWrite}
      />

      <PlaceThings
        householdId={householdId}
        placeId={place.id}
        timezone={membership.household.timezone}
        locale={membership.household.locale}
        canWrite={canWrite}
      />

      <PlaceForm
        open={sheet === 'edit'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        tree={tree}
        place={place}
        photo={photo}
      />
      <PlaceForm
        open={sheet === 'add'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        tree={tree}
        defaultParentId={place.id}
      />
      <MoveSheet open={sheet === 'move'} onClose={() => setSheet(null)} place={place} tree={tree} />
    </div>
  );
}
