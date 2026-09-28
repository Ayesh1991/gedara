import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import {
  PLACE_TYPE_ICONS,
  createPlaceType,
  placeTypesKey,
  updatePlaceType,
  type PlaceType,
  type PlaceTypeIcon,
} from '@/lib/places';
import { cn } from '@/lib/utils';
import { TYPE_ICON } from './PlaceVisuals';

/** 23505 = a type with that name already exists in this household. */
function typeErrorKey(e: unknown): 'duplicate' | 'denied' | 'generic' {
  const code = (e as { code?: string } | null)?.code;
  if (code === '23505') return 'duplicate';
  if (code === '42501') return 'denied';
  return 'generic';
}

/**
 * A place type of the household's own ("Tool wall", "Suitcase" …): a name and an icon (Phase 7d).
 * New (`type` omitted) or editing one. No <form>: it opens on top of the place form.
 */
export function PlaceTypeSheet({
  open,
  onClose,
  householdId,
  type,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  type?: PlaceType | null;
  onSaved?: (t: PlaceType) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t(type ? 'placeTypes.editTitle' : 'placeTypes.newTitle')}>
      {open && <Body householdId={householdId} type={type ?? null} onClose={onClose} onSaved={onSaved} />}
    </Sheet>
  );
}

function Body({
  householdId,
  type,
  onClose,
  onSaved,
}: {
  householdId: string;
  type: PlaceType | null;
  onClose: () => void;
  onSaved?: (t: PlaceType) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(type?.name ?? '');
  const [icon, setIcon] = useState<PlaceTypeIcon>((type?.icon as PlaceTypeIcon) ?? 'box');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let saved: PlaceType;
      if (type) {
        await updatePlaceType(type.id, { name: name.trim(), icon });
        saved = { ...type, name: name.trim(), icon };
      } else {
        saved = await createPlaceType(householdId, name, icon);
      }
      await qc.invalidateQueries({ queryKey: placeTypesKey(householdId) });
      toast.success(t('placeTypes.saved', { name: saved.name }));
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error(t(`placeTypes.errors.${typeErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="place-type-sheet">
      <div>
        <label htmlFor="place-type-name" className="mb-1.5 block text-[13px] font-medium text-muted">
          {t('placeTypes.name')}
        </label>
        <Input
          id="place-type-name"
          autoFocus
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // don't submit the place form underneath
            void save();
          }}
          placeholder={t('placeTypes.namePlaceholder')}
          autoComplete="off"
        />
      </div>
      <fieldset>
        <legend className="mb-1.5 block text-[13px] font-medium text-muted">{t('placeTypes.icon')}</legend>
        <div className="grid grid-cols-8 gap-1.5">
          {PLACE_TYPE_ICONS.map((k) => {
            const Icon = TYPE_ICON[k];
            const on = icon === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                aria-label={k}
                onClick={() => setIcon(k)}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-xl border',
                  on ? 'accent-pill border-transparent text-text' : 'border-line-2 bg-white/[0.03] text-muted',
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
              </button>
            );
          })}
        </div>
      </fieldset>
      <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()} className="w-full">
        {busy ? t('common.saving') : t('placeTypes.save')}
      </Button>
    </div>
  );
}
