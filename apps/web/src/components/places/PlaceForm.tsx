import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { ImageError } from '@/lib/images';
import {
  CLIMATES,
  PLACE_KINDS,
  createPlace,
  invalidatePlaces,
  placeErrorKey,
  removePlacePhoto,
  setPlacePhoto,
  updatePlace,
  type Climate,
  type Place,
  type PlaceKind,
  type PlacePhoto,
} from '@/lib/places';
import { moveTargets, type Tree } from '@/lib/tree';
import { cn } from '@/lib/utils';
import { KIND_ICON } from './PlaceVisuals';

const fieldLabel = 'mb-1.5 block text-[13px] font-medium text-muted';
const selectClass =
  'h-12 w-full rounded-[14px] border border-line-2 bg-[#0d1326] px-3.5 text-[16px] text-text focus:border-accent-a focus:outline-none';

interface PlaceFormProps {
  open: boolean;
  onClose: () => void;
  householdId: string;
  tree: Tree<Place>;
  place?: Place | null;
  photo?: PlacePhoto | null;
  defaultParentId?: string | null;
  onSaved?: (p: Place) => void;
}

/** Create or edit a place: ≤ 5 visible fields (§5.4); climate + notes under "More details". */
export function PlaceForm(props: PlaceFormProps) {
  const { t } = useTranslation();
  // The sheet mounts its content only while open, so the form starts fresh every time.
  return (
    <Sheet open={props.open} onClose={props.onClose} title={t(props.place ? 'places.editTitle' : 'places.addTitle')}>
      <PlaceFormBody {...props} />
    </Sheet>
  );
}

function PlaceFormBody({ onClose, householdId, tree, place, photo, defaultParentId, onSaved }: PlaceFormProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(place?.name ?? '');
  const [kind, setKind] = useState<PlaceKind | null>(
    (place?.kind as PlaceKind | null) ?? (place ? null : defaultParentId ? 'container' : 'room'),
  );
  const [parentId, setParentId] = useState<string | null>(place ? place.parent_id : (defaultParentId ?? null));
  const [climate, setClimate] = useState<Climate | null>((place?.climate as Climate | null) ?? null);
  const [notes, setNotes] = useState(place?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [dropPhoto, setDropPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const parents = useMemo(
    () =>
      (place ? moveTargets(tree, place.id) : [...tree.byId.values()]).sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }),
      ),
    [tree, place],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const input = { name, kind, parentId, climate, notes: notes || null };
      const saved = place ? await updatePlace(place.id, input) : await createPlace(householdId, input);
      if (file) {
        try {
          await setPlacePhoto(householdId, saved.id, file, photo);
        } catch (err) {
          const reason = err instanceof ImageError ? err.reason : 'upload';
          toast.error(t(`places.photoErrors.${reason}`));
        }
      } else if (dropPhoto && photo) {
        await removePlacePhoto(photo);
      }
      await invalidatePlaces(qc, householdId);
      toast.success(t(place ? 'places.saved' : 'places.created', { name: saved.name }));
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error(t(`places.errors.${placeErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  const showPhoto = preview ?? (!dropPhoto ? photo?.thumbUrl : null);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="place-name" className={fieldLabel}>
          {t('places.fields.name')}
        </label>
        <Input
          id="place-name"
          autoFocus
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('places.fields.namePlaceholder')}
          autoComplete="off"
        />
      </div>

      <fieldset>
        <legend className={fieldLabel}>{t('places.fields.kind')}</legend>
        <div className="flex flex-wrap gap-2">
          {PLACE_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            const on = kind === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(on ? null : k)}
                className={cn(
                  'inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[14px] transition-colors',
                  on ? 'accent-pill border-transparent text-text' : 'border-line-2 bg-white/[0.03] text-muted',
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
                {t(`places.kinds.${k}`)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor="place-parent" className={fieldLabel}>
          {t('places.fields.inside')}
        </label>
        <select
          id="place-parent"
          className={selectClass}
          value={parentId ?? ''}
          onChange={(e) => setParentId(e.target.value || null)}
        >
          <option value="">{t('places.topLevel')}</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.path}
            </option>
          ))}
        </select>
      </div>

      <div>
        <span className={fieldLabel}>{t('places.fields.photo')}</span>
        <div className="flex items-center gap-3">
          <label className="glass flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl">
            {showPhoto ? (
              <img src={showPhoto} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlus className="h-6 w-6 text-muted" aria-hidden />
            )}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label={t('places.fields.photo')}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setDropPhoto(false);
              }}
            />
          </label>
          <div className="flex-1 text-[13px] leading-snug text-muted">{t('places.fields.photoHint')}</div>
          {(file || (photo && !dropPhoto)) && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('places.removePhoto')}
              onClick={() => {
                setFile(null);
                setDropPhoto(true);
              }}
            >
              <Trash className="h-[18px] w-[18px]" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <details className="group rounded-2xl border border-line bg-white/[0.02] px-4 py-3">
        <summary className="cursor-pointer text-[14px] font-medium text-muted select-none">
          {t('places.moreDetails')}
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <div>
            <label htmlFor="place-climate" className={fieldLabel}>
              {t('places.fields.climate')}
            </label>
            <select
              id="place-climate"
              className={selectClass}
              value={climate ?? ''}
              onChange={(e) => setClimate((e.target.value || null) as Climate | null)}
            >
              <option value="">{t('places.climateNone')}</option>
              {CLIMATES.map((c) => (
                <option key={c} value={c}>
                  {t(`places.climates.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="place-notes" className={fieldLabel}>
              {t('places.fields.notes')}
            </label>
            <textarea
              id="place-notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[16px] text-text placeholder:text-faint focus:border-accent-a focus:outline-none"
            />
          </div>
        </div>
      </details>

      <Button type="submit" variant="primary" className="w-full" disabled={busy || !name.trim()}>
        {busy ? t('places.saving') : t(place ? 'places.save' : 'places.add')}
      </Button>
    </form>
  );
}
