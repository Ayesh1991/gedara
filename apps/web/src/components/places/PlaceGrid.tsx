import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Square, SquareCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { placePhotosQuery, placesQuery, type Place, type PlacePhoto } from '@/lib/places';
import { buildTree, childrenOf, descendants, type Tree } from '@/lib/tree';
import { cn } from '@/lib/utils';
import { KindChip, PlaceArt } from './PlaceVisuals';

/** All places + photos for the household, and the tree built from them. */
export function usePlaces(householdId: string) {
  const places = useQuery(placesQuery(householdId));
  const photos = useQuery(placePhotosQuery(householdId));
  const tree = useMemo(() => buildTree(places.data ?? []), [places.data]);
  return { places, photos: photos.data, tree };
}

function PlaceTile({
  place,
  tree,
  photo,
  selecting,
  selected,
  onToggle,
}: {
  place: Place;
  tree: Tree<Place>;
  photo?: PlacePhoto | null;
  selecting: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const inside = childrenOf(tree, place.id).length;
  const all = inside ? descendants(tree, place.id).length : 0;

  const body = (
    <>
      <div className="relative aspect-[4/3] overflow-hidden">
        <PlaceArt name={place.name} kind={place.kind} photo={photo} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[rgba(5,7,15,0.85)] to-transparent" />
        {selecting && (
          <span className="absolute top-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-xl bg-[rgba(5,7,15,0.6)] backdrop-blur">
            {selected ? (
              <SquareCheck className="h-5 w-5 text-accent-b" aria-hidden />
            ) : (
              <Square className="h-5 w-5 text-white/70" aria-hidden />
            )}
          </span>
        )}
        {all > 0 && (
          <span className="tabular absolute bottom-2 left-3 text-[11.5px] text-white/85">
            {t('places.insideCount', { count: all })}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3.5">
        <div className="truncate font-display text-[15.5px] font-semibold">{place.name}</div>
        <div className="flex min-h-7 items-center gap-2">
          <KindChip kind={place.kind} />
        </div>
      </div>
    </>
  );

  const cls = cn(
    'glass group block overflow-hidden rounded-[22px] text-left transition-[border-color,transform] hover:border-white/25 active:scale-[0.99]',
    selected && 'border-accent-b shadow-[0_0_0_1px_var(--accent-b),0_0_28px_-6px_var(--accent-b)]',
  );

  return selecting ? (
    <button type="button" aria-pressed={selected} className={cn(cls, 'w-full')} onClick={() => onToggle(place.id)}>
      {body}
    </button>
  ) : (
    <Link to="/places/$placeId" params={{ placeId: place.id }} className={cls}>
      {body}
    </Link>
  );
}

export function PlaceGrid({
  items,
  tree,
  photos,
  selecting = false,
  selected,
  onToggle,
}: {
  items: Place[];
  tree: Tree<Place>;
  photos?: Map<string, PlacePhoto>;
  selecting?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
      {items.map((p) => (
        <li key={p.id}>
          <PlaceTile
            place={p}
            tree={tree}
            photo={photos?.get(p.id)}
            selecting={selecting}
            selected={selected?.has(p.id) ?? false}
            onToggle={onToggle ?? (() => undefined)}
          />
        </li>
      ))}
    </ul>
  );
}

export function PlacesSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="glass aspect-[4/4.3] animate-pulse rounded-[22px]" />
      ))}
    </ul>
  );
}
