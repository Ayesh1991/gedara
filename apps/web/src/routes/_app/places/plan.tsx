import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ImagePlus, Map as MapIcon, MapPin, Move, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState } from '@/components/aurora/EmptyState';
import { usePlaces } from '@/components/places/PlaceGrid';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import {
  clampPin,
  createPlan,
  deletePlan,
  floorPlansQuery,
  invalidatePlans,
  pinsQuery,
  placePin,
  planPhotosQuery,
  renamePlan,
  setPlanPicture,
  type Pin,
} from '@/lib/floorPlan';
import { ImageError } from '@/lib/images';
import { locationContentsQuery } from '@/lib/insights/queries';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({ plan: z.string().max(40).optional() });

export const Route = createFileRoute('/_app/places/plan')({
  validateSearch: SearchSchema,
  component: PlanPage,
});

const KEY_STEP = 0.01;

/** Places › Floor plan (MASTER_PLAN §5.2): a picture per floor with rooms pinned on it. */
function PlanPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = Route.useNavigate();
  const { plan: planParam } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const plans = useQuery(floorPlansQuery(householdId));
  const photos = useQuery(planPhotosQuery(householdId));
  const pins = useQuery(pinsQuery(householdId));
  const contents = useQuery(locationContentsQuery(householdId));
  const { tree } = usePlaces(householdId);
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const list = plans.data ?? [];
  const plan = list.find((p) => p.id === planParam) ?? list[0] ?? null;
  const photo = plan ? photos.data?.get(plan.id) : undefined;
  const refresh = () => invalidatePlans(qc, householdId);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!naming?.name.trim()) return;
    setBusy(true);
    try {
      if (naming.id) await renamePlan(naming.id, naming.name);
      else {
        const id = await createPlan(householdId, naming.name, list.length);
        void navigate({ search: { plan: id }, replace: true });
      }
      await refresh();
      setNaming(null);
    } catch {
      toast.error(t('plan.errors.save'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan || !window.confirm(t('plan.confirmDelete', { name: plan.name }))) return;
    try {
      await deletePlan(plan.id, photo);
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['places', householdId] })]);
      void navigate({ search: {}, replace: true });
      setEditing(false);
    } catch {
      toast.error(t('plan.errors.save'));
    }
  }

  async function upload(file: File | undefined) {
    if (!file || !plan) return;
    setBusy(true);
    try {
      await setPlanPicture(householdId, plan.id, file, photo);
      await refresh();
    } catch (e) {
      toast.error(e instanceof ImageError ? t('plan.errors.image') : t('plan.errors.save'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/places" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.places')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('plan.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('plan.intro')}</p>
      </div>

      {plans.isPending ? (
        <div className="glass h-72 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : !plan ? (
        <EmptyState
          icon={MapIcon}
          title={t('plan.emptyTitle')}
          body={t('plan.emptyBody')}
          action={
            canWrite && (
              <Button variant="primary" onClick={() => setNaming({ id: null, name: '' })}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('plan.addFloor')}
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label={t('plan.floors')} className="glass inline-flex flex-wrap rounded-2xl p-1">
              {list.map((p) => (
                <button
                  key={p.id}
                  role="tab"
                  type="button"
                  aria-selected={p.id === plan.id}
                  onClick={() => void navigate({ search: { plan: p.id }, replace: true })}
                  className={cn('h-10 rounded-xl px-4 text-[14px] font-medium', p.id === plan.id ? 'accent-pill text-text' : 'text-muted')}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {canWrite && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setNaming({ id: null, name: '' })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('plan.addFloor')}
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant={editing ? 'accent' : 'secondary'} onClick={() => setEditing((e) => !e)} data-testid="plan-edit">
                  {editing ? <X className="h-4 w-4" aria-hidden /> : <Move className="h-4 w-4" aria-hidden />}
                  {editing ? t('plan.done') : t('plan.edit')}
                </Button>
              </>
            )}
          </div>

          {!photo ? (
            <Card className="flex flex-col items-start gap-3">
              <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('plan.noPicture')}</p>
              {canWrite && <PictureButton busy={busy} onFile={(f) => void upload(f)} label={t('plan.addPicture')} />}
            </Card>
          ) : (
            <PlanCanvas
              key={plan.id}
              planId={plan.id}
              imageUrl={photo.fullUrl ?? photo.thumbUrl}
              pins={(pins.data ?? []).filter((p) => p.floor_plan_id === plan.id)}
              counts={contents.data}
              editing={editing}
              onChanged={() => void Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['places', householdId] })])}
              unpinned={[...tree.byId.values()]
                .filter((p) => !(pins.data ?? []).some((x) => x.id === p.id))
                .sort((a, b) => Number(b.kind === 'room') - Number(a.kind === 'room') || a.path.localeCompare(b.path))}
            />
          )}

          {editing && (
            <Card className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setNaming({ id: plan.id, name: plan.name })}>
                <Pencil className="h-4 w-4" aria-hidden />
                {t('plan.rename')}
              </Button>
              {photo && <PictureButton busy={busy} onFile={(f) => void upload(f)} label={t('plan.replacePicture')} />}
              <Button size="sm" variant="destructive" onClick={() => void remove()}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('plan.deleteFloor')}
              </Button>
            </Card>
          )}
        </>
      )}

      <Sheet open={naming !== null} onClose={() => setNaming(null)} title={naming?.id ? t('plan.rename') : t('plan.addFloor')}>
        <form onSubmit={saveName} className="flex flex-col gap-3">
          <Input
            aria-label={t('plan.floorName')}
            placeholder={t('plan.floorPlaceholder')}
            maxLength={60}
            autoFocus
            value={naming?.name ?? ''}
            onChange={(e) => setNaming((n) => (n ? { ...n, name: e.target.value } : n))}
          />
          <Button type="submit" variant="primary" disabled={busy || !naming?.name.trim()}>
            {t('plan.save')}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}

function PictureButton({ busy, onFile, label }: { busy: boolean; onFile: (f: File | undefined) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="accent" disabled={busy} onClick={() => input.current?.click()}>
        <ImagePlus className="h-4 w-4" aria-hidden />
        {label}
      </Button>
    </>
  );
}

interface Counts {
  location_id: string;
  products: number;
  assets: number;
}

/** The picture with its pins. Editing: drag a pin (or focus it and use the arrow keys). */
function PlanCanvas({
  planId,
  imageUrl,
  pins,
  counts,
  editing,
  onChanged,
  unpinned,
}: {
  planId: string;
  imageUrl: string | null;
  pins: Pin[];
  counts: Counts[] | undefined;
  editing: boolean;
  onChanged: () => void;
  unpinned: Array<{ id: string; name: string; path: string }>;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const byId = useMemo(() => new Map((counts ?? []).map((c) => [c.location_id, c])), [counts]);

  const at = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clampPin((e.clientX - r.left) / r.width), y: clampPin((e.clientY - r.top) / r.height) };
  };

  async function save(id: string, x: number | null, y: number | null) {
    try {
      await placePin(id, x === null ? null : planId, x, y);
      onChanged();
    } catch {
      toast.error(t('plan.errors.save'));
    }
  }

  function onKey(e: KeyboardEvent, pin: Pin) {
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const cur = moving?.id === pin.id ? moving : pin;
    setMoving({ id: pin.id, x: clampPin(cur.x + d[0]!), y: clampPin(cur.y + d[1]!) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div ref={box} className="relative w-full overflow-hidden rounded-[var(--r)] border border-line bg-[#0b1020]" data-testid="plan-canvas">
        {imageUrl && <img src={imageUrl} alt="" className="block w-full select-none" draggable={false} />}
        {pins.map((pin) => {
          const pos = moving?.id === pin.id ? moving : pin;
          const c = byId.get(pin.id);
          const n = (c?.products ?? 0) + (c?.assets ?? 0);
          const style = { left: `${pos.x * 100}%`, top: `${pos.y * 100}%` };
          const label = (
            <>
              <MapPin className="h-5 w-5 shrink-0 text-accent-b drop-shadow" aria-hidden />
              <span className="max-w-[9rem] truncate">{pin.name}</span>
              {n > 0 && <span className="tabular text-muted">· {n}</span>}
            </>
          );
          const cls = cn(
            'absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full bg-[rgba(5,7,15,0.82)] py-1 pr-2.5 pl-1.5 text-[12.5px] font-medium whitespace-nowrap backdrop-blur',
            editing && 'cursor-grab touch-none ring-1 ring-accent-a',
            selected === pin.id && 'ring-2',
          );
          return editing ? (
            <button
              key={pin.id}
              type="button"
              className={cls}
              style={style}
              aria-label={t('plan.movePin', { name: pin.name })}
              data-testid="plan-pin"
              onClick={() => setSelected(pin.id)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setSelected(pin.id);
                setMoving({ id: pin.id, ...at(e) });
              }}
              onPointerMove={(e) => {
                if (moving?.id === pin.id && e.buttons) setMoving({ id: pin.id, ...at(e) });
              }}
              onPointerUp={() => moving?.id === pin.id && void save(pin.id, moving.x, moving.y).then(() => setMoving(null))}
              onKeyDown={(e) => onKey(e, pin)}
              onKeyUp={() => moving?.id === pin.id && void save(pin.id, moving.x, moving.y)}
            >
              {label}
            </button>
          ) : (
            <Link key={pin.id} to="/places/$placeId" params={{ placeId: pin.id }} className={cls} style={style} data-testid="plan-pin">
              {label}
            </Link>
          );
        })}
      </div>

      {editing && (
        <Card className="flex flex-col gap-3">
          <p className="text-[13px] text-[#a5b0d0]">{t('plan.editHint')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              aria-label={t('plan.pinPlace')}
              className="glass h-11 flex-1 rounded-xl px-3 text-[14px]"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">{t('plan.pinPlace')}</option>
              {unpinned.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.path}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              className="h-11"
              disabled={!adding}
              onClick={() => {
                void save(adding, 0.5, 0.5);
                setSelected(adding);
                setAdding('');
              }}
            >
              <MapPin className="h-4 w-4" aria-hidden />
              {t('plan.pin')}
            </Button>
          </div>
          {selected && pins.some((p) => p.id === selected) && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => void save(selected, null, null).then(() => setSelected(null))}>
              <X className="h-4 w-4" aria-hidden />
              {t('plan.unpin', { name: pins.find((p) => p.id === selected)?.name ?? '' })}
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
