import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, Check, ChevronRight, Package, PackagePlus, Plus, Search, Tag, Wrench } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PlaceTypeSheet } from '@/components/places/PlaceTypeSheet';
import { KIND_ICON, kindIcon, usePlaceTypes } from '@/components/places/PlaceVisuals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { assignTag, detachTag, invalidateLabels, tagErrorKey } from '@/lib/labels/blank';
import { blankLabelText, type TagKind, type TagTarget } from '@/lib/labels/tags';
import type { PlaceKind } from '@/lib/places';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { CreateSheet, type CreateRequest } from './CreateSheet';
import { ItemPicker } from './ItemPicker';

/** The place kinds offered first for a new label (a box is by far the most common). */
const NEW_PLACE_KINDS: PlaceKind[] = ['container', 'shelf', 'cupboard', 'rack', 'file', 'drawer', 'furniture', 'room'];

export interface Claimed {
  target: TagTarget;
  name: string;
  /** Made just now (with the context's place preset), not an existing item. */
  created: boolean;
}

/**
 * "New label — what is this?" (Phase 7b): a blank label becomes a new or existing place, thing or
 * product. `placeId` presets where a new item goes (Fill this box); `allow` limits the choices
 * (Put in a place: places only).
 */
export function ClaimPanel({
  householdId,
  code,
  sheetNo,
  slot,
  placeId,
  allow = ['location', 'asset', 'product'],
  onClaimed,
  onCancel,
  onBusyChange,
  className,
}: {
  householdId: string;
  code: string;
  sheetNo: number | null;
  slot: number;
  placeId?: string | null;
  allow?: TagKind[];
  onClaimed?: (c: Claimed) => void;
  /** "Not now": leave the label blank (Put / Fill modes carry on). */
  onCancel?: () => void;
  /** A form or picker is open (the page stops taking scans meanwhile). */
  onBusyChange?: (busy: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [create, setCreate] = useState<CreateRequest | null>(null);
  const [picking, setPicking] = useState<TagKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [newType, setNewType] = useState(false);
  const typeSaved = useRef(false);
  const types = usePlaceTypes();

  const open = (c: CreateRequest | null, p: TagKind | null) => {
    setCreate(c);
    setPicking(p);
    onBusyChange?.(Boolean(c || p));
  };

  async function assign(target: TagTarget, name: string, created: boolean) {
    setBusy(true);
    try {
      await assignTag(code, target);
      await invalidateLabels(qc, householdId);
      toast.success(t('scan.claim.assigned', { name }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            detachTag(code, target.id)
              .then(() => invalidateLabels(qc, householdId))
              .then(() => toast(t('scan.claim.detached')))
              .catch((e: unknown) => toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`)));
          },
        },
      });
      onClaimed?.({ target, name, created });
    } catch (e) {
      toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  return (
    <div className={cn('glass-strong slide-up flex flex-col gap-3.5 rounded-3xl p-4', className)} role="status" data-testid="claim-panel">
      <div className="flex items-start gap-3">
        <div className="brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[#05070F]">
          <Tag className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[18px] font-semibold">{t('scan.claim.title')}</div>
          <div className="tabular text-[12px] text-muted">
            {code}
            {sheetNo !== null && <> · {blankLabelText(sheetNo, slot)}</>}
          </div>
        </div>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('scan.claim.notNow')}
          </Button>
        )}
      </div>

      {offline ? (
        <p className="text-[13.5px] text-caution">{t('scan.claim.needsInternet')}</p>
      ) : (
        <>
          {allow.includes('location') && (
            <div className="flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-muted">{t('scan.claim.aPlace')}</div>
              <div className="flex flex-wrap gap-2">
                {NEW_PLACE_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <Button
                      key={k}
                      size="sm"
                      variant={k === 'container' ? 'accent' : 'secondary'}
                      disabled={busy}
                      onClick={() => open({ kind: 'place', placeKind: k, placeId }, null)}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                      {t('scan.claim.newKind', { kind: t(`places.kinds.${k}`) })}
                    </Button>
                  );
                })}
                {types
                  .filter((x) => !x.archived)
                  .map((x) => {
                    const Icon = kindIcon(null, x);
                    return (
                      <Button
                        key={x.id}
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => open({ kind: 'place', placeTypeId: x.id, placeId }, null)}
                      >
                        <Icon className="h-4 w-4" aria-hidden />
                        {t('scan.claim.newKind', { kind: x.name })}
                      </Button>
                    );
                  })}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setNewType(true);
                    onBusyChange?.(true);
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('placeTypes.new')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(null, 'location')}>
                  <Search className="h-4 w-4" aria-hidden />
                  {t('scan.claim.existingPlace')}
                </Button>
              </div>
            </div>
          )}
          {allow.includes('asset') && (
            <div className="flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-muted">{t('scan.claim.aThing')}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => open({ kind: 'thing', placeId }, null)}>
                  <Wrench className="h-4 w-4" aria-hidden />
                  {t('scan.claim.newThing')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(null, 'asset')}>
                  <Search className="h-4 w-4" aria-hidden />
                  {t('scan.claim.existingThing')}
                </Button>
              </div>
            </div>
          )}
          {allow.includes('product') && (
            <div className="flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-muted">{t('scan.claim.aProduct')}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => open({ kind: 'product', placeId }, null)}>
                  <Package className="h-4 w-4" aria-hidden />
                  {t('scan.claim.newProduct')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(null, 'product')}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('scan.claim.existingProduct')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <PlaceTypeSheet
        open={newType}
        onClose={() => {
          setNewType(false);
          // Saved: the new place's form opens next and keeps the page busy.
          if (!typeSaved.current) onBusyChange?.(false);
          typeSaved.current = false;
        }}
        householdId={householdId}
        onSaved={(x) => {
          typeSaved.current = true;
          open({ kind: 'place', placeTypeId: x.id, placeId }, null);
        }}
      />
      {create && (
        <CreateSheet
          householdId={householdId}
          request={create}
          onCreated={(c) => void assign(c.target, c.name, true)}
          onClose={() => open(null, null)}
        />
      )}
      {picking && (
        <ItemPicker
          householdId={householdId}
          kind={picking}
          onClose={() => open(null, null)}
          onPick={(item) => {
            const kind = picking;
            open(null, null);
            void assign({ kind, id: item.id }, item.name, false);
          }}
        />
      )}
    </div>
  );
}

/** After a label was assigned: open it, and the natural next step (Fill this box / Put in a place). */
export function ClaimedCard({ claimed }: { claimed: Claimed }) {
  const { t } = useTranslation();
  const { target, name } = claimed;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="claimed">
      <div className="flex items-center gap-2 text-[15px]">
        <Check className="h-5 w-5 text-teal" aria-hidden />
        {t('scan.claim.nowOpens', { name })}
      </div>
      <div className="flex flex-wrap gap-2">
        {target.kind === 'location' ? (
          <Link to="/scan" search={{ fill: target.id }} className="accent-pill inline-flex h-11 items-center gap-1.5 rounded-[14px] px-4 font-display font-semibold">
            <PackagePlus className="h-4 w-4" aria-hidden />
            {t('scan.fill.start')}
          </Link>
        ) : (
          <Link
            to="/scan"
            search={{ put: `${target.kind}:${target.id}` }}
            className="accent-pill inline-flex h-11 items-center gap-1.5 rounded-[14px] px-4 font-display font-semibold"
          >
            <ArrowDownToLine className="h-4 w-4" aria-hidden />
            {t('scan.put.start')}
          </Link>
        )}
        <Link
          {...(target.kind === 'location'
            ? { to: '/places/$placeId', params: { placeId: target.id } }
            : target.kind === 'asset'
              ? { to: '/things/$assetId', params: { assetId: target.id } }
              : { to: '/pantry/$productId', params: { productId: target.id } })}
          className="glass inline-flex h-11 items-center gap-1.5 rounded-[14px] px-4 text-[14px]"
        >
          {t('scan.open')}
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}
