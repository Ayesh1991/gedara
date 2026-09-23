import { useQueryClient } from '@tanstack/react-query';
import { CornerLeftUp, ScanLine, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CameraScanner } from '@/components/scan/CameraScanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { invalidatePlaces, placeErrorKey, updatePlace, type Place } from '@/lib/places';
import { resolveScan } from '@/lib/resolve';
import { moveTargets, type Tree } from '@/lib/tree';
import { KindIcon } from './PlaceVisuals';

/** Move a place: pick the new parent from the list, or scan the label on it. */
export function MoveSheet({
  open,
  onClose,
  place,
  tree,
}: {
  open: boolean;
  onClose: () => void;
  place: Place;
  tree: Tree<Place>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  const targets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return moveTargets(tree, place.id)
      .filter((p) => p.id !== place.parent_id && (!needle || p.path.toLowerCase().includes(needle)))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  }, [tree, place, q]);

  async function moveTo(parentId: string | null, label: string) {
    if (busy) return;
    setBusy(true);
    try {
      await updatePlace(place.id, { parentId });
      await invalidatePlaces(qc, place.household_id);
      toast.success(t('places.moved', { name: place.name, target: label }));
      onClose();
    } catch (e) {
      toast.error(t(`places.errors.${placeErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  async function onScan(text: string) {
    const r = await resolveScan(text).catch(() => null);
    if (r?.status !== 'place') {
      toast.error(t('places.moveScanNotPlace'));
      return;
    }
    if (!moveTargets(tree, place.id).some((p) => p.id === r.place.id)) {
      toast.error(t('places.errors.cycle'));
      return;
    }
    setScanning(false);
    await moveTo(r.place.id, r.place.name);
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        setScanning(false);
        setQ('');
        onClose();
      }}
      title={t('places.moveTitle', { name: place.name })}
    >
      {scanning ? (
        <div className="flex flex-col gap-3">
          <CameraScanner onDetect={(text) => void onScan(text)} autoStart compact className="aspect-square w-full" />
          <Button variant="secondary" onClick={() => setScanning(false)}>
            {t('places.moveChooseFromList')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Button variant="accent" onClick={() => setScanning(true)}>
            <ScanLine className="h-[18px] w-[18px]" aria-hidden />
            {t('places.moveScan')}
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('places.moveSearch')}
              aria-label={t('places.moveSearch')}
              className="pl-10"
            />
          </div>
          <ul className="flex max-h-[46dvh] flex-col gap-1.5 overflow-y-auto">
            {place.parent_id && (
              <li>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void moveTo(null, t('places.topLevel'))}
                  className="flex w-full items-center gap-3 rounded-2xl bg-white/[0.03] px-3.5 py-3 text-left hover:bg-white/[0.06]"
                >
                  <CornerLeftUp className="h-[18px] w-[18px] text-accent-b" aria-hidden />
                  <span className="text-[15px]">{t('places.topLevel')}</span>
                </button>
              </li>
            )}
            {targets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void moveTo(p.id, p.name)}
                    className="flex w-full items-center gap-3 rounded-2xl bg-white/[0.03] px-3.5 py-3 text-left hover:bg-white/[0.06]"
                  >
                    <KindIcon kind={p.kind} className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[15px]">{p.path}</span>
                  </button>
                </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}
