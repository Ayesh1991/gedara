import { useQueryClient } from '@tanstack/react-query';
import { QrCode, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { parseScan } from '@/lib/codes';
import { assignTag, detachTag, invalidateLabels, tagErrorKey } from '@/lib/labels/blank';
import type { TagTarget } from '@/lib/labels/tags';
import { moveErrorKey } from '@/lib/moves';
import { invalidatePantry, pantryErrorKey, updateProduct } from '@/lib/pantry/queries';
import { resolveScan } from '@/lib/resolve';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { putItem } from './flow';
import { ScanSheet } from './ScanField';

// One-step scans on an item's page (Phase 7c): scan a place label → the item is kept there;
// scan a blank label → it becomes this item's extra label. Camera or USB scanner, with Undo.

const iconButton =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-2 bg-white/5 text-accent-b transition-colors hover:text-text';

/**
 * A thing's "Kept in", a place's "Inside" or a product's usual place: scan the place's label and it
 * is saved at once. `currentPlaceId` is what Undo puts back.
 */
export function ScanPlaceButton({
  householdId,
  target,
  name,
  currentPlaceId,
  className,
}: {
  householdId: string;
  target: TagTarget;
  name: string;
  currentPlaceId: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fail = (text: string) => {
    setMsg(text);
    return false;
  };

  async function scanned(text: string): Promise<boolean> {
    let r;
    try {
      r = await resolveScan(text);
    } catch {
      return fail(t('scan.lookupFailed'));
    }
    if (r.status !== 'place') return fail(t('scan.instant.notAPlace'));
    const place = r.place;
    if (place.id === currentPlaceId || (target.kind === 'location' && place.id === target.id)) {
      toast(t('scan.instant.alreadyThere', { place: place.name }));
      return true;
    }
    const label = t('scan.put.label', { name, place: place.name });
    try {
      if (target.kind === 'product') {
        await updateProduct(target.id, { default_location_id: place.id });
        await invalidatePantry(qc, householdId);
        toast.success(t('scan.instant.usualPlace', { name, place: place.name }), {
          duration: UNDO_MS,
          action: {
            label: t('common.undo'),
            onClick: () => {
              updateProduct(target.id, { default_location_id: currentPlaceId })
                .then(() => invalidatePantry(qc, householdId))
                .catch((e: unknown) => toast.error(t(`pantry.errors.${pantryErrorKey(e)}`)));
            },
          },
        });
        return true;
      }
      const done = await putItem(qc, householdId, target.kind, target.id, place.id, label);
      toast.success(label, {
        description: done.queued ? t('offline.queued') : undefined,
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            done.undo().catch((e: unknown) => toast.error(t(`moves.errors.${moveErrorKey(e)}`)));
          },
        },
      });
      return true;
    } catch (e) {
      return fail(target.kind === 'product' ? t(`pantry.errors.${pantryErrorKey(e)}`) : t(`moves.errors.${moveErrorKey(e)}`));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMsg(null);
          setOpen(true);
        }}
        aria-label={t('scan.instant.scanPlace', { name })}
        className={cn(iconButton, className)}
        data-testid="scan-place"
      >
        <ScanLine className="h-4 w-4" aria-hidden />
      </button>
      <ScanSheet
        open={open}
        onClose={() => setOpen(false)}
        onScan={scanned}
        message={msg}
        title={t('scan.instant.placeTitle', { name })}
        hint={t('scan.instant.placeHint')}
      />
    </>
  );
}

/** "Add label": scan a blank label (HL:TAG) and it opens this item from now on, next to its own code. */
export function AddLabelButton({ householdId, target, name, className }: { householdId: string; target: TagTarget; name: string; className?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fail = (text: string) => {
    setMsg(text);
    return false;
  };

  async function scanned(text: string): Promise<boolean> {
    if (parseScan(text).kind !== 'tag') return fail(t('scan.instant.notBlank'));
    let r;
    try {
      r = await resolveScan(text);
    } catch {
      return fail(t('scan.lookupFailed'));
    }
    if (r.status === 'retiredTag') return fail(t('scan.claim.errors.retired'));
    if (r.status === 'place' || r.status === 'asset' || r.status === 'product') {
      const id = r.status === 'place' ? r.place.id : r.status === 'asset' ? r.asset.id : r.product.id;
      const owner = r.status === 'place' ? r.place.name : r.status === 'asset' ? r.asset.name : r.product.name;
      if (id !== target.id) return fail(t('scan.instant.alreadyOpens', { name: owner }));
      toast(t('scan.instant.alreadyThis'));
      return true;
    }
    if (r.status !== 'blankTag') return fail(r.status === 'offline' ? t('scan.claim.needsInternet') : t('scan.claim.errors.unknown'));
    const code = r.code;
    try {
      await assignTag(code, target);
      await invalidateLabels(qc, householdId);
      toast.success(t('scan.instant.labelAdded', { name }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            detachTag(code, target.id)
              .then(() => invalidateLabels(qc, householdId))
              .catch((e: unknown) => toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`)));
          },
        },
      });
      return true;
    } catch (e) {
      return fail(t(`scan.claim.errors.${tagErrorKey(e)}`));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMsg(null);
          setOpen(true);
        }}
        className={cn('mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-text', className)}
        data-testid="add-label"
      >
        <QrCode className="h-3.5 w-3.5" aria-hidden />
        {t('scan.instant.addLabel')}
      </button>
      <ScanSheet
        open={open}
        onClose={() => setOpen(false)}
        onScan={scanned}
        message={msg}
        title={t('scan.instant.labelTitle', { name })}
        hint={t('scan.instant.labelHint')}
      />
    </>
  );
}
