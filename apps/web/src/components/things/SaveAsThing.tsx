import { useQuery } from '@tanstack/react-query';
import { membershipQuery } from '@/lib/queries';
import { AssetForm } from './AssetForm';
import { useThings } from './bits';

/**
 * "Save as a thing instead" (Phase 7e): the product form noticed a Things category (a book, a
 * tool …), so the thing form opens with what was typed and scanned so far.
 */
export function SaveAsThing({
  householdId,
  name,
  categoryId,
  barcode,
  onSaved,
  onClose,
}: {
  householdId: string;
  name: string;
  categoryId: string | null;
  barcode: string | null;
  onSaved: (id: string, name: string) => void;
  onClose: () => void;
}) {
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
      initial={{ name: name || undefined, category_id: categoryId, barcode: barcode || null }}
      onSaved={onSaved}
    />
  );
}
