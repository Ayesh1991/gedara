import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePantry } from '@/components/pantry/bits';
import { usePlaces } from '@/components/places/PlaceGrid';
import { useThings } from '@/components/things/bits';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import type { TagKind } from '@/lib/labels/tags';
import { assetTag } from '@/lib/things/value';

export interface PickItem {
  id: string;
  name: string;
  sub?: string | null;
}

/** "An existing place / thing / product": search and tap one. */
export function ItemPicker({
  householdId,
  kind,
  onPick,
  onClose,
}: {
  householdId: string;
  kind: TagKind;
  onPick: (item: PickItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open onClose={onClose} title={t(`scan.claim.pick.${kind}`)}>
      {kind === 'location' ? (
        <PlaceList householdId={householdId} onPick={onPick} />
      ) : kind === 'asset' ? (
        <ThingList householdId={householdId} onPick={onPick} />
      ) : (
        <ProductList householdId={householdId} onPick={onPick} />
      )}
    </Sheet>
  );
}

function PlaceList({ householdId, onPick }: { householdId: string; onPick: (i: PickItem) => void }) {
  const { places } = usePlaces(householdId);
  const items = useMemo(
    () => (places.data ?? []).map((p) => ({ id: p.id, name: p.name, sub: p.path.split(' › ').slice(0, -1).join(' › ') || null })),
    [places.data],
  );
  return <List items={items} onPick={onPick} />;
}

function ThingList({ householdId, onPick }: { householdId: string; onPick: (i: PickItem) => void }) {
  const { assets } = useThings(householdId);
  const items = useMemo(
    () => (assets.data ?? []).filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, sub: assetTag(a.asset_no) })),
    [assets.data],
  );
  return <List items={items} onPick={onPick} />;
}

function ProductList({ householdId, onPick }: { householdId: string; onPick: (i: PickItem) => void }) {
  const { products } = usePantry(householdId);
  const items = useMemo(
    () => (products.data ?? []).filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, sub: p.name_si })),
    [products.data],
  );
  return <List items={items} onPick={onPick} />;
}

function List({ items, onPick }: { items: PickItem[]; onPick: (i: PickItem) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const hits = query
      ? items.filter((i) => i.name.toLowerCase().includes(query) || (i.sub ?? '').toLowerCase().includes(query))
      : items;
    return [...hits].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
  }, [items, q]);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          className="pl-10"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('scan.claim.search')}
          aria-label={t('scan.claim.search')}
          autoComplete="off"
        />
      </div>
      <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
        {shown.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onPick(i)}
              className="flex min-h-11 w-full flex-col items-start justify-center rounded-xl px-3 py-1.5 text-left hover:bg-white/[0.06]"
            >
              <span className="w-full truncate text-[14.5px]">{i.name}</span>
              {i.sub && <span className="w-full truncate text-[12px] text-muted">{i.sub}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-2 text-[13.5px] text-muted">{t('scan.claim.nothing')}</li>}
      </ul>
    </div>
  );
}
