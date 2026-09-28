import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { ProductForm } from '@/components/pantry/ProductForm';
import { usePantry } from '@/components/pantry/bits';
import { usePlaces } from '@/components/places/PlaceGrid';
import { PlaceForm } from '@/components/places/PlaceForm';
import { AssetForm } from '@/components/things/AssetForm';
import { useThings } from '@/components/things/bits';
import type { TagTarget } from '@/lib/labels/tags';
import type { PlaceKind } from '@/lib/places';
import { membershipQuery } from '@/lib/queries';

export type CreateKind = 'place' | 'thing' | 'product';

/** What to make, and what the scan already told us. */
export interface CreateRequest {
  kind: CreateKind;
  /** Place: its parent · thing: where it is · product: its usual place ("Fill this box"). */
  placeId?: string | null;
  placeKind?: PlaceKind | null;
  /** …or one of the household's own place types. */
  placeTypeId?: string | null;
  /** Product or thing: a scanned retail barcode (a thing keeps it too since Phase 7e: a book's ISBN). */
  barcode?: string | null;
  /** Prefill from a form it came from ("Save as a thing instead"). */
  name?: string | null;
  categoryId?: string | null;
  /** Thing: a scanned serial-number barcode. */
  serial?: string | null;
}

export interface Created {
  target: TagTarget;
  name: string;
}

/**
 * The normal create form (≤ 5 fields, §5.4) for a scan-first entry. `onCreated` fires once the item
 * is saved; `onClose` whenever the sheet goes away (saved or cancelled).
 */
export function CreateSheet({
  householdId,
  request,
  onCreated,
  onClose,
}: {
  householdId: string;
  request: CreateRequest;
  onCreated: (c: Created) => void;
  onClose: () => void;
}) {
  if (request.kind === 'place') return <NewPlace householdId={householdId} request={request} onCreated={onCreated} onClose={onClose} />;
  if (request.kind === 'thing') return <NewThing householdId={householdId} request={request} onCreated={onCreated} onClose={onClose} />;
  return <NewProduct householdId={householdId} request={request} onCreated={onCreated} onClose={onClose} />;
}

interface Props {
  householdId: string;
  request: CreateRequest;
  onCreated: (c: Created) => void;
  onClose: () => void;
}

function NewPlace({ householdId, request, onCreated, onClose }: Props) {
  const { tree } = usePlaces(householdId);
  return (
    <PlaceForm
      open
      onClose={onClose}
      householdId={householdId}
      tree={tree}
      defaultParentId={request.placeId ?? null}
      defaultKind={request.placeKind ?? null}
      defaultTypeId={request.placeTypeId ?? null}
      onSaved={(p) => onCreated({ target: { kind: 'location', id: p.id }, name: p.name })}
    />
  );
}

function NewThing({ householdId, request, onCreated, onClose }: Props) {
  const things = useThings(householdId);
  const membership = useQuery(membershipQuery);
  if (!things.categories.data) return null;
  return (
    <AssetForm
      open
      onClose={onClose}
      householdId={householdId}
      locale={membership.data?.household.locale ?? 'en-LK'}
      categories={things.categories.data}
      tree={things.tree}
      assets={things.assets.data ?? []}
      tags={things.tags.data ?? []}
      fields={things.fields.data ?? []}
      initial={{
        location_id: request.placeId ?? null,
        serial: request.serial ?? null,
        barcode: request.barcode ?? null,
        name: request.name ?? undefined,
        category_id: request.categoryId ?? null,
      }}
      onSaved={(id, name) => onCreated({ target: { kind: 'asset', id }, name })}
    />
  );
}

function NewProduct({ householdId, request, onCreated, onClose }: Props) {
  const pantry = usePantry(householdId);
  // Fires once: ProductForm's delete path also calls onSaved (with an empty id).
  const done = useRef(false);
  if (!pantry.units.data) return null;
  return (
    <ProductForm
      open
      onClose={onClose}
      householdId={householdId}
      units={pantry.units.data}
      categories={pantry.categories.data ?? []}
      products={pantry.products.data ?? []}
      tree={pantry.tree}
      barcode={request.barcode ?? null}
      initial={{ default_location_id: request.placeId ?? null }}
      onSaved={(p) => {
        if (!p.id || done.current) return;
        done.current = true;
        onCreated({ target: { kind: 'product', id: p.id }, name: p.name });
      }}
    />
  );
}
