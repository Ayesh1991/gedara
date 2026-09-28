import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowDownToLine, Check, ChevronRight, CloudOff, PackagePlus, Plus, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePantry } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { assignTag, invalidateLabels, tagErrorKey } from '@/lib/labels/blank';
import type { TagTarget } from '@/lib/labels/tags';
import { moveErrorKey } from '@/lib/moves';
import { pantryErrorKey, updateProduct } from '@/lib/pantry/queries';
import { formatQty, parseQty } from '@/lib/pantry/units';
import { placesQuery } from '@/lib/places';
import { resolveScan, type Resolved } from '@/lib/resolve';
import { assetsQuery } from '@/lib/things/queries';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { ClaimPanel, ClaimedCard, type Claimed } from './ClaimPanel';
import { CreateSheet, type CreateRequest } from './CreateSheet';
import { deleteCreated, putItem, putStock, type Done } from './flow';
import { ScanResult } from './ScanResult';

// The Scan screen's modes (Phase 7b). Each one takes over what a scan means — camera, USB scanner and
// typed/pasted codes alike — through `register`:
//   put   "Put in a place": the next place label is where the item goes
//   fill  "Fill this box":  every item scanned goes into the box, with Undo per row
//   add   Quick add:        every scan opens the new thing / product form, prefilled
//   claim a blank label:    "New label — what is this?"

export type ScanHandler = (text: string) => void;
export type Register = (fn: ScanHandler | null) => void;

export type PutTarget = { kind: 'asset' | 'product' | 'location'; id: string };

/** `asset:<uuid>` → { kind, id } (the ?put= search param). */
export function parsePut(v: string | undefined): PutTarget | null {
  const m = /^(asset|product|location):([0-9a-f-]{36})$/i.exec(v ?? '');
  return m ? { kind: m[1]!.toLowerCase() as PutTarget['kind'], id: m[2]!.toLowerCase() } : null;
}

// Retail / shop barcodes as product_barcode stores them (migration 24).
const BARCODE = /^[0-9A-Za-z._-]{4,64}$/;

/** Registers a mode's scan handler while mounted; the latest closure is always used. */
function useRegister(register: Register, handler: ScanHandler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    register((text) => ref.current(text));
    return () => register(null);
  }, [register]);
}

async function resolveOrToast(text: string, failed: string): Promise<Resolved | null> {
  try {
    return await resolveScan(text);
  } catch {
    toast.error(failed);
    return null;
  }
}

function useItemName(householdId: string, target: PutTarget | null): string | null {
  const pantry = usePantry(householdId);
  const assets = useQuery({ ...assetsQuery(householdId), enabled: target?.kind === 'asset' });
  const places = useQuery(placesQuery(householdId));
  if (!target) return null;
  if (target.kind === 'asset') return assets.data?.find((a) => a.id === target.id)?.name ?? null;
  if (target.kind === 'product') return pantry.products.data?.find((p) => p.id === target.id)?.name ?? null;
  return places.data?.find((p) => p.id === target.id)?.name ?? null;
}

/**
 * The bar above the camera: what the mode is doing, and Done. Rendered into `el` (a slot the Scan
 * page keeps above the viewfinder) so it stays in thumb reach while the lists grow below.
 */
export function ModeBanner({
  el,
  title,
  hint,
  onDone,
  doneLabel,
}: {
  el: HTMLElement | null;
  title: string;
  hint?: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const banner = <Banner title={title} hint={hint} onDone={onDone} doneLabel={doneLabel} />;
  return el ? createPortal(banner, el) : banner;
}

function Banner({ title, hint, onDone, doneLabel }: { title: string; hint?: string; onDone: () => void; doneLabel?: string }) {
  const { t } = useTranslation();
  return (
    <div className="glass-strong flex items-center gap-3 rounded-2xl px-4 py-3" data-testid="scan-mode">
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[16px] font-semibold">{title}</div>
        {hint && <div className="truncate text-[12.5px] text-muted">{hint}</div>}
      </div>
      <Button size="sm" variant="accent" onClick={onDone}>
        <Check className="h-4 w-4" aria-hidden />
        {doneLabel ?? t('scan.modes.done')}
      </Button>
    </div>
  );
}

// ── Put in a place ────────────────────────────────────────────────────────────

export function PutMode({ householdId, target, register, bannerEl }: { householdId: string; target: PutTarget; register: Register; bannerEl: HTMLElement | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pantry = usePantry(householdId);
  const name = useItemName(householdId, target) ?? t('scan.put.thisItem');
  const product = target.kind === 'product' ? pantry.products.data?.find((p) => p.id === target.id) : undefined;
  const unit = product ? pantry.units.data?.get(product.stock_unit_id) : undefined;
  const [howMuch, setHowMuch] = useState<string | null>(null);
  const [claim, setClaim] = useState<Extract<Resolved, { status: 'blankTag' }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ placeId: string; placeName: string; noStock?: boolean } | null>(null);

  const putInto = useCallback(
    async (placeId: string, placeName: string) => {
      if (target.kind === 'location' && placeId === target.id) return void toast.error(t('scan.put.samePlace'));
      setBusy(true);
      const label = t('scan.put.label', { name, place: placeName });
      try {
        let r: Done;
        if (target.kind === 'product') {
          if (product && product.stock.qty <= 0) {
            setDone({ placeId, placeName, noStock: true });
            return;
          }
          const qty = howMuch ? parseQty(howMuch) : null;
          r = await putStock(qc, householdId, target.id, placeId, label, qty ? { qty, unitId: product?.stock_unit_id ?? null } : undefined);
        } else {
          r = await putItem(qc, householdId, target.kind, target.id, placeId, label);
        }
        setDone({ placeId, placeName });
        toast.success(r.qty !== undefined ? t('scan.put.movedStock', { qty: formatQty(r.qty, unit), name, place: placeName }) : label, {
          description: r.queued ? t('offline.queued') : undefined,
          duration: UNDO_MS,
          action: {
            label: t('common.undo'),
            onClick: () => {
              r.undo()
                .then(() => {
                  setDone(null);
                  toast(t('scan.put.undone'));
                })
                .catch((e: unknown) => toast.error(t(`moves.errors.${moveErrorKey(e)}`)));
            },
          },
        });
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        toast.error(code === 'GDSTK' ? t('scan.put.alreadyThere') : target.kind === 'product' ? t(`pantry.errors.${pantryErrorKey(e)}`) : t(`moves.errors.${moveErrorKey(e)}`));
      } finally {
        setBusy(false);
      }
    },
    [target, product, unit, howMuch, householdId, name, qc, t],
  );

  const handle = useCallback(
    async (text: string) => {
      if (busy || claim || done) return;
      const r = await resolveOrToast(text, t('scan.lookupFailed'));
      if (!r) return;
      if (r.status === 'place') return putInto(r.place.id, r.place.name);
      if (r.status === 'blankTag') return setClaim(r);
      toast.error(t('scan.put.notAPlace'));
    },
    [busy, claim, done, putInto, t],
  );
  useRegister(register, (text) => void handle(text));

  const exit = () => void navigate({ to: '/scan', search: {} });

  async function makeUsualPlace(placeId: string) {
    try {
      await updateProduct(target.id, { default_location_id: placeId });
      await qc.invalidateQueries({ queryKey: ['pantry', householdId] });
      toast.success(t('scan.put.usualSet'));
      exit();
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ModeBanner el={bannerEl} title={t('scan.put.title', { name })} hint={done ? undefined : t('scan.put.hint')} onDone={exit} doneLabel={done ? undefined : t('common.cancel')} />
      {target.kind === 'product' && !done && (
        <Card className="flex flex-col gap-2 p-4">
          {howMuch === null ? (
            <div className="flex items-center justify-between gap-3 text-[14px]">
              <span>
                {t('scan.put.allOfIt')}
                {product && <span className="tabular text-muted"> · {formatQty(product.stock.qty, unit)}</span>}
              </span>
              <button type="button" className="text-[13px] text-accent-b underline-offset-2 hover:underline" onClick={() => setHowMuch('')}>
                {t('scan.put.howMuch')}
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 text-[14px]">
              {t('scan.put.howMuchLabel')}
              <Input
                inputMode="decimal"
                autoFocus
                value={howMuch}
                onChange={(e) => setHowMuch(e.target.value)}
                placeholder={t('scan.put.allPlaceholder')}
                className="tabular h-11 w-28"
              />
              <span className="text-muted">{unit?.code}</span>
            </label>
          )}
        </Card>
      )}
      {claim && (
        <ClaimPanel
          householdId={householdId}
          code={claim.code}
          sheetNo={claim.sheetNo}
          slot={claim.slot}
          allow={['location']}
          onCancel={() => setClaim(null)}
          onClaimed={(c) => {
            setClaim(null);
            void putInto(c.target.id, c.name);
          }}
        />
      )}
      {done && (
        <Card className="flex flex-col gap-3 p-4" data-testid="put-done">
          <div className="flex items-center gap-2 text-[15px]">
            <ArrowDownToLine className="h-5 w-5 text-teal" aria-hidden />
            {done.noStock ? t('scan.put.noStock', { name }) : t('scan.put.doneText', { name, place: done.placeName })}
          </div>
          <div className="flex flex-wrap gap-2">
            {done.noStock && (
              <Button size="sm" variant="accent" onClick={() => void makeUsualPlace(done.placeId)}>
                {t('scan.put.makeUsual')}
              </Button>
            )}
            <Link to="/scan" search={{ fill: done.placeId }} className="glass inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[14px]">
              <PackagePlus className="h-4 w-4" aria-hidden />
              {t('scan.fill.start')}
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Fill this box ─────────────────────────────────────────────────────────────

interface Row {
  key: number;
  name: string;
  state: 'done' | 'queued' | 'error' | 'undone' | 'info';
  message?: string;
  undo?: () => Promise<void>;
}

export function FillMode({ householdId, placeId, register, bannerEl }: { householdId: string; placeId: string; register: Register; bannerEl: HTMLElement | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pantry = usePantry(householdId);
  const places = useQuery(placesQuery(householdId));
  const box = places.data?.find((p) => p.id === placeId);
  const [rows, setRows] = useState<Row[]>([]);
  const [claim, setClaim] = useState<Extract<Resolved, { status: 'blankTag' }> | null>(null);
  const [create, setCreate] = useState<CreateRequest | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const counter = useRef(0);

  const add = useCallback((row: Omit<Row, 'key'>) => setRows((r) => [{ ...row, key: ++counter.current }, ...r].slice(0, 60)), []);
  const patch = (key: number, p: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)));

  /** Put one item into the box: a place or a thing moves, a product moves all its stock. */
  const putTarget = useCallback(
    async (target: TagTarget, name: string) => {
      const label = t('scan.put.label', { name, place: box?.name ?? '' });
      try {
        if (target.kind === 'location') {
          if (target.id === placeId) return add({ name, state: 'info', message: t('scan.fill.thisBox') });
          const d = await putItem(qc, householdId, 'location', target.id, placeId, label);
          return add({ name, state: d.queued ? 'queued' : 'done', undo: d.undo });
        }
        if (target.kind === 'asset') {
          const d = await putItem(qc, householdId, 'asset', target.id, placeId, label);
          return add({ name, state: d.queued ? 'queued' : 'done', undo: d.undo });
        }
        const p = pantry.products.data?.find((x) => x.id === target.id);
        if (p && p.stock.qty <= 0) {
          // Nothing to move: this box simply becomes where it's usually kept (Undo puts the old one
          // back), so filling carries on without a stop.
          const before = p.default_location_id ?? null;
          if (before === placeId) return add({ name, state: 'info', message: t('scan.fill.alreadyUsual') });
          await updateProduct(target.id, { default_location_id: placeId });
          await qc.invalidateQueries({ queryKey: ['pantry', householdId] });
          return add({
            name,
            state: 'done',
            message: t('scan.fill.nowUsual'),
            undo: async () => {
              await updateProduct(target.id, { default_location_id: before });
              await qc.invalidateQueries({ queryKey: ['pantry', householdId] });
            },
          });
        }
        const d = await putStock(qc, householdId, target.id, placeId, label);
        const unit = p ? pantry.units.data?.get(p.stock_unit_id) : undefined;
        add({ name, state: d.queued ? 'queued' : 'done', message: d.qty !== undefined ? formatQty(d.qty, unit) : undefined, undo: d.undo });
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        add({
          name,
          state: 'error',
          message:
            code === 'GDSTK'
              ? t('scan.put.alreadyThere')
              : target.kind === 'product'
                ? t(`pantry.errors.${pantryErrorKey(e)}`)
                : t(`moves.errors.${moveErrorKey(e)}`),
        });
      }
    },
    [add, box?.name, placeId, householdId, pantry.products.data, pantry.units.data, qc, t],
  );

  const fillWith = useCallback(
    async (r: Resolved) => {
      if (r.status === 'place') return putTarget({ kind: 'location', id: r.place.id }, r.place.name);
      if (r.status === 'asset') return putTarget({ kind: 'asset', id: r.asset.id }, r.asset.name);
      if (r.status === 'product') return putTarget({ kind: 'product', id: r.product.id }, r.product.name);
      if (r.status === 'blankTag') return setClaim(r);
      if (r.status === 'assetChoice') {
        return add({ name: r.assets[0]!.name, state: 'error', message: t('scan.fill.copies', { count: r.assets.length }) });
      }
      if (r.status === 'unknownBarcode') {
        setFormOpen(true);
        return setCreate({ kind: 'product', barcode: r.code, placeId });
      }
      add({ name: t(`scan.short.${r.status}`), state: 'error' });
    },
    [add, putTarget, placeId, t],
  );

  const handle = useCallback(
    async (text: string) => {
      if (claim || formOpen) return;
      const r = await resolveOrToast(text, t('scan.lookupFailed'));
      if (r) await fillWith(r);
    },
    [claim, formOpen, fillWith, t],
  );
  useRegister(register, (text) => void handle(text));

  async function undoRow(row: Row) {
    if (!row.undo) return;
    patch(row.key, { undo: undefined });
    try {
      await row.undo();
      patch(row.key, { state: 'undone' });
    } catch (e) {
      patch(row.key, { undo: row.undo });
      toast.error(t(`moves.errors.${moveErrorKey(e)}`));
    }
  }

  const moved = rows.filter((r) => r.state === 'done' || r.state === 'queued').length;

  return (
    <div className="flex flex-col gap-3">
      <ModeBanner
        el={bannerEl}
        title={t('scan.fill.title', { place: box?.path ?? '…' })}
        hint={t('scan.fill.hint', { count: moved })}
        onDone={() => void navigate({ to: '/places/$placeId', params: { placeId } })}
      />
      {claim && (
        <ClaimPanel
          householdId={householdId}
          code={claim.code}
          sheetNo={claim.sheetNo}
          slot={claim.slot}
          placeId={placeId}
          onBusyChange={setFormOpen}
          onCancel={() => setClaim(null)}
          onClaimed={(c: Claimed) => {
            setClaim(null);
            // A new item was made inside this box already; an existing one is put in now.
            if (c.created) add({ name: c.name, state: 'done', message: t('scan.fill.newHere') });
            else void putTarget(c.target, c.name);
          }}
        />
      )}
      {create && (
        <CreateSheet
          householdId={householdId}
          request={create}
          onCreated={(c) => add({ name: c.name, state: 'done', message: t('scan.fill.newHere') })}
          onClose={() => {
            setCreate(null);
            setFormOpen(false);
          }}
        />
      )}
      <Card className="flex flex-col gap-2 p-4" data-testid="fill-list">
        {rows.length === 0 ? (
          <p className="text-[13.5px] text-muted">{t('scan.fill.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 py-2" data-testid="fill-row">
                <RowIcon state={row.state} />
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate text-[14px]', row.state === 'undone' && 'text-muted line-through')}>{row.name}</div>
                  {row.message && <div className={cn('truncate text-[12px]', row.state === 'error' ? 'text-caution' : 'text-muted')}>{row.message}</div>}
                </div>
                {row.undo && (row.state === 'done' || row.state === 'queued') && (
                  <Button size="sm" variant="ghost" onClick={() => void undoRow(row)} aria-label={t('scan.fill.undoRow', { name: row.name })}>
                    <Undo2 className="h-4 w-4" aria-hidden />
                    {t('common.undo')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RowIcon({ state }: { state: Row['state'] }) {
  if (state === 'queued') return <CloudOff className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />;
  if (state === 'error') return <X className="h-4 w-4 shrink-0 text-caution" aria-hidden />;
  if (state === 'undone' || state === 'info') return <span className="h-4 w-4 shrink-0" aria-hidden />;
  return <Check className="h-4 w-4 shrink-0 text-teal" aria-hidden />;
}

// ── Quick add ─────────────────────────────────────────────────────────────────

export function AddMode({
  householdId,
  kind,
  register,
  bannerEl,
}: {
  householdId: string;
  kind: 'thing' | 'product';
  register: Register;
  bannerEl: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [create, setCreate] = useState<(CreateRequest & { tag?: string }) | null>(null);
  const [existing, setExisting] = useState<{ id: number; result: Resolved } | null>(null);
  const [added, setAdded] = useState<Array<{ target: TagTarget; name: string; key: number }>>([]);
  const counter = useRef(0);

  const handle = useCallback(
    async (text: string) => {
      if (create) return;
      const r = await resolveOrToast(text, t('scan.lookupFailed'));
      if (!r) return;
      const raw = text.trim();
      if (r.status === 'blankTag') return setCreate({ kind, tag: r.code });
      if (kind === 'product') {
        if (r.status === 'unknownBarcode') return setCreate({ kind, barcode: r.code });
        if (r.status === 'invalid' && BARCODE.test(raw)) return setCreate({ kind, barcode: raw });
        if (r.status === 'product') return setExisting({ id: ++counter.current, result: r });
      } else {
        if (r.status === 'asset' || r.status === 'assetChoice') return setExisting({ id: ++counter.current, result: r });
        // A retail barcode (a book's ISBN) is the thing's barcode; any other code is its serial number.
        if (r.status === 'unknownBarcode') return setCreate({ kind, barcode: r.code });
        if (r.status === 'invalid' && raw.length <= 120) return setCreate({ kind, serial: raw });
      }
      setExisting({ id: ++counter.current, result: r });
    },
    [create, kind, t],
  );
  useRegister(register, (text) => void handle(text));

  async function created(target: TagTarget, name: string, tag?: string) {
    setExisting(null);
    setAdded((a) => [{ target, name, key: ++counter.current }, ...a].slice(0, 50));
    if (tag) {
      try {
        await assignTag(tag, target);
        await invalidateLabels(qc, householdId);
      } catch (e) {
        toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`));
      }
    }
    toast.success(t('scan.add.saved', { name }), {
      duration: UNDO_MS,
      action: {
        label: t('common.undo'),
        onClick: () => {
          deleteCreated(qc, householdId, target)
            .then(() => {
              setAdded((a) => a.filter((x) => x.target.id !== target.id));
              toast(t('scan.add.removed', { name }));
            })
            .catch(() => toast.error(t('scan.add.cantRemove')));
        },
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <ModeBanner
        el={bannerEl}
        title={t(`scan.add.title.${kind}`)}
        hint={t(`scan.add.hint.${kind}`)}
        onDone={() => void navigate(kind === 'thing' ? { to: '/things' } : { to: '/pantry' })}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setCreate({ kind })}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('scan.add.byHand')}
        </Button>
        <Link
          to="/scan"
          search={{ add: kind === 'thing' ? 'product' : 'thing' }}
          className="glass inline-flex h-9 items-center rounded-xl px-3 text-[14px] text-muted hover:text-text"
        >
          {t(`scan.add.switch.${kind}`)}
        </Link>
      </div>
      {existing && <ScanResult key={existing.id} result={existing.result} />}
      <Card className="flex flex-col gap-2 p-4" data-testid="added-list">
        <h2 className="font-display text-[15px] font-semibold">{t('scan.add.added', { count: added.length })}</h2>
        {added.length === 0 ? (
          <p className="text-[13.5px] text-muted">{t(`scan.add.empty.${kind}`)}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {added.map((a) => (
              <li key={a.key}>
                <Link
                  {...(a.target.kind === 'asset'
                    ? { to: '/things/$assetId', params: { assetId: a.target.id } }
                    : { to: '/pantry/$productId', params: { productId: a.target.id } })}
                  className="flex h-10 items-center gap-2 rounded-xl px-3 text-[14px] hover:bg-white/[0.05]"
                >
                  <Check className="h-4 w-4 text-teal" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {create && (
        <CreateSheet
          householdId={householdId}
          request={create}
          onCreated={(c) => void created(c.target, c.name, create.tag)}
          onClose={() => setCreate(null)}
        />
      )}
    </div>
  );
}

// ── A blank label (?claim=…, also /s/HL:TAG:… deep links) ─────────────────────

export function ClaimMode({
  householdId,
  code,
  register,
  bannerEl,
  onScanElsewhere,
}: {
  householdId: string;
  code: string;
  register: Register;
  bannerEl: HTMLElement | null;
  /** Another code was scanned: leave the claim and handle it like the plain Scan screen. */
  onScanElsewhere: (text: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const resolved = useQuery({ queryKey: ['scan-claim', code], queryFn: () => resolveScan(code), staleTime: 0, gcTime: 0 });
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [busy, setBusy] = useState(false);
  const handle = useCallback(
    (text: string) => {
      if (!busy) onScanElsewhere(text);
    },
    [busy, onScanElsewhere],
  );
  useRegister(register, handle);
  const r = resolved.data;

  const body = useMemo(() => {
    if (claimed) return <ClaimedCard claimed={claimed} />;
    if (!r) return resolved.isError ? <p className="text-[14px] text-caution">{t('scan.lookupFailed')}</p> : null;
    if (r.status === 'blankTag') {
      return (
        <ClaimPanel householdId={householdId} code={r.code} sheetNo={r.sheetNo} slot={r.slot} onBusyChange={setBusy} onClaimed={setClaimed} />
      );
    }
    return <ScanResult result={r} />;
  }, [claimed, r, resolved.isError, householdId, t]);

  return (
    <div className="flex flex-col gap-3">
      <ModeBanner el={bannerEl} title={t('scan.claim.modeTitle')} hint={code} onDone={() => void navigate({ to: '/scan', search: {} })} />
      {body}
    </div>
  );
}
