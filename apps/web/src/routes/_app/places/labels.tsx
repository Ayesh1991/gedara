import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, Crosshair, Download, Minus, Plus, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import regularWoff from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff?url';
import boldWoff from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff?url';
import { usePlaces } from '@/components/places/PlaceGrid';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { labelUrl, shortLabelText } from '@/lib/codes';
import { env } from '@/lib/env';
import type { FontBytes } from '@/lib/labels/pdf';
import { cellRect, layoutSheets, pageSize, type SheetProfile } from '@/lib/labels/sheet';
import { composeSq20, encodePng1bit, rasterizeText, sq20TextArea } from '@/lib/labels/bitmap';
import { productsQuery } from '@/lib/pantry/queries';
import { labelProfileQuery, saveLabelProfile, type Place } from '@/lib/places';
import { rawCodeQr } from '@/lib/qr';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({
  ids: z.string().optional(),
  /** Product ids (HL:PRD labels for jars and loose goods). */
  products: z.string().optional(),
  mode: z.enum(['a4', 'niimbot']).optional(),
});

export const Route = createFileRoute('/_app/places/labels')({
  validateSearch: SearchSchema,
  component: LabelsPage,
});

function download(bytes: Uint8Array | Blob, name: string, type: string) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function loadFonts(): Promise<FontBytes | undefined> {
  try {
    const [regular, bold] = await Promise.all([regularWoff, boldWoff].map((u) => fetch(u).then((r) => r.arrayBuffer())));
    return { regular: regular!, bold: bold! };
  } catch {
    return undefined; // Helvetica fallback
  }
}

const stamp = () => new Date().toISOString().slice(0, 10);

function LabelsPage() {
  const { t } = useTranslation();
  const { ids = '', products: productIds = '', mode = 'a4' } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const { places, tree } = usePlaces(householdId);
  const products = useQuery({ ...productsQuery(householdId), enabled: Boolean(productIds) });

  const selected = useMemo((): LabelItem[] => {
    const wanted = ids.split(',').filter(Boolean);
    const placeItems = wanted.map((id) => tree.byId.get(id)).filter((p): p is Place => Boolean(p));
    const wantedProducts = new Set(productIds.split(',').filter(Boolean));
    // A product label's small line is its name; there is no breadcrumb.
    const productItems = (products.data ?? [])
      .filter((p) => wantedProducts.has(p.id))
      .map((p) => ({ id: p.id, code: p.code, name: p.name, path: p.name }));
    return [...placeItems, ...productItems];
  }, [ids, productIds, tree, products.data]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/places" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.places')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('labels.title')}</h1>
        <p className="tabular mt-1 text-[14px] text-muted">{t('labels.count', { count: selected.length })}</p>
      </div>

      <div role="tablist" aria-label={t('labels.printer')} className="glass inline-flex self-start rounded-2xl p-1">
        {(['a4', 'niimbot'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => void navigate({ search: (s) => ({ ...s, mode: m }), replace: true })}
            className={cn(
              'h-10 rounded-xl px-4 text-[14px] font-medium transition-colors',
              mode === m ? 'accent-pill text-text' : 'text-muted',
            )}
          >
            {t(`labels.modes.${m}`)}
          </button>
        ))}
      </div>

      {places.isPending || (Boolean(productIds) && products.isPending) ? null : selected.length === 0 ? (
        <Card className="text-[14px] text-[#a5b0d0]">{t('labels.none')}</Card>
      ) : mode === 'a4' ? (
        <A4Studio places={selected} householdId={householdId} canWrite={membership.role !== 'viewer'} />
      ) : (
        <NiimbotStudio places={selected} />
      )}
    </div>
  );
}

// ── A4 (Epson) ────────────────────────────────────────────────────────────────

/** What a label needs: places and products both have a code, a name and a breadcrumb path. */
type LabelItem = Pick<Place, 'id' | 'code' | 'name' | 'path'>;

function A4Studio({ places, householdId, canWrite }: { places: LabelItem[]; householdId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const saved = useQuery(labelProfileQuery(householdId));
  const [draft, setDraft] = useState<SheetProfile | null>(null);
  const profile = draft ?? saved.data?.profile;
  const [start, setStart] = useState({ row: 0, col: 0 });
  const [busy, setBusy] = useState(false);

  if (!profile) return <div className="glass h-[420px] animate-pulse rounded-[var(--r)]" aria-hidden />;
  const page = pageSize(profile);
  const placed = layoutSheets(profile, places, start.row, start.col);
  const sheets = (placed.at(-1)?.page ?? 0) + 1;
  const firstIndex = start.row * profile.cols + start.col;
  const set = (patch: Partial<SheetProfile>) => setDraft({ ...profile, ...patch });

  async function makePdf() {
    if (!profile) return;
    setBusy(true);
    try {
      const { buildSheetPdf } = await import('@/lib/labels/pdf');
      const pdf = await buildSheetPdf({
        profile,
        startRow: start.row,
        startCol: start.col,
        fonts: await loadFonts(),
        labels: places.map((p) => ({
          url: labelUrl(p.code, env.VITE_PUBLIC_BASE_URL),
          name: p.name,
          crumb: p.path.split(' › ').slice(0, -1).join(' › '),
        })),
      });
      download(pdf, `gedara-labels-${stamp()}.pdf`, 'application/pdf');
    } catch {
      toast.error(t('labels.pdfFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function calibration() {
    if (!profile) return;
    const caption = t('labels.calibrationCaption', { x: profile.offsetX, y: profile.offsetY });
    const { buildCalibrationPdf } = await import('@/lib/labels/pdf');
    download(await buildCalibrationPdf(profile, caption, await loadFonts()), `gedara-calibration-${stamp()}.pdf`, 'application/pdf');
  }

  async function save() {
    if (!profile || !saved.data) return;
    try {
      await saveLabelProfile(householdId, saved.data, profile);
      await qc.invalidateQueries({ queryKey: labelProfileQuery(householdId).queryKey });
      setDraft(null);
      toast.success(t('labels.saved'));
    } catch {
      toast.error(t('labels.saveFailed'));
    }
  }

  const num = (label: string, value: number, key: keyof SheetProfile, step = 0.5, min = 0, max = 60) => (
    <label className="flex flex-col gap-1 text-[12.5px] text-muted">
      {label}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set({ [key]: Math.min(max, Math.max(min, v)) } as Partial<SheetProfile>);
        }}
        className="tabular h-11 rounded-xl border border-line-2 bg-white/5 px-3 text-[15px] text-text focus:border-accent-a focus:outline-none"
      />
    </label>
  );

  const nudge = (label: string, key: 'offsetX' | 'offsetY') => (
    <div className="flex flex-col gap-1 text-[12.5px] text-muted">
      {label}
      <div className="flex items-center gap-1.5">
        <Button size="icon" aria-label={t('labels.less', { what: label })} onClick={() => set({ [key]: Math.max(-20, profile[key] - 0.5) })}>
          <Minus className="h-4 w-4" aria-hidden />
        </Button>
        <span className="tabular w-16 text-center text-[15px] text-text">
          {profile[key].toFixed(1)} mm
        </span>
        <Button size="icon" aria-label={t('labels.more', { what: label })} onClick={() => set({ [key]: Math.min(20, profile[key] + 0.5) })}>
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-[17px] font-semibold">{t('labels.sheetPreview')}</h2>
          <span className="tabular text-[12.5px] text-muted">{t('labels.sheets', { count: sheets })}</span>
        </div>
        <p className="text-[13px] text-[#a5b0d0]">{t('labels.tapStart')}</p>
        <svg
          viewBox={`0 0 ${page.w} ${page.h}`}
          className="w-full rounded-xl bg-[#f4f5f8]"
          role="img"
          aria-label={t('labels.sheetPreview')}
        >
          {Array.from({ length: profile.rows * profile.cols }, (_, i) => {
            const row = Math.floor(i / profile.cols);
            const col = i % profile.cols;
            const r = cellRect(profile, row, col);
            const used = i < firstIndex;
            const label = placed.find((p) => p.page === 0 && p.row === row && p.col === col);
            return (
              <g
                key={i}
                onClick={() => setStart({ row, col })}
                className="cursor-pointer"
                aria-label={t('labels.startHere', { row: row + 1, col: col + 1 })}
              >
                <rect
                  x={r.x + 0.6}
                  y={r.y + 0.6}
                  width={r.w - 1.2}
                  height={r.h - 1.2}
                  rx={1.5}
                  fill={used ? '#d9dce5' : '#ffffff'}
                  stroke={label ? '#7c3aed' : '#c7cbd8'}
                  strokeWidth={label ? 0.5 : 0.3}
                  strokeDasharray={used ? '1 1' : undefined}
                />
                {label && (
                  <>
                    <rect
                      x={r.x + (r.w - Math.min(profile.qrMm, r.w - 3)) / 2}
                      y={r.y + 1.5}
                      width={Math.min(profile.qrMm, r.w - 3)}
                      height={Math.min(profile.qrMm, r.w - 3)}
                      fill="#1b1f2d"
                      rx={0.6}
                    />
                    <text
                      x={r.x + r.w / 2}
                      y={r.y + Math.min(profile.qrMm, r.w - 3) + 5}
                      fontSize={2.6}
                      textAnchor="middle"
                      fill="#1b1f2d"
                      fontFamily="Space Grotesk, sans-serif"
                      fontWeight={700}
                    >
                      {label.item.name.length > 16 ? `${label.item.name.slice(0, 15)}…` : label.item.name}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <Button variant="primary" onClick={() => void makePdf()} disabled={busy}>
            <Download className="h-[18px] w-[18px]" aria-hidden />
            {busy ? t('labels.building') : t('labels.downloadPdf')}
          </Button>
          <Button variant="secondary" onClick={() => void calibration()}>
            <Crosshair className="h-[18px] w-[18px]" aria-hidden />
            {t('labels.calibration')}
          </Button>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">{t('labels.printHint')}</p>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="font-display text-[17px] font-semibold">{t('labels.printerSettings')}</h2>
        <p className="text-[13px] leading-relaxed text-[#a5b0d0]">{t('labels.calibrationHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {nudge(t('labels.offsetX'), 'offsetX')}
          {nudge(t('labels.offsetY'), 'offsetY')}
        </div>
        <details className="rounded-2xl border border-line bg-white/[0.02] px-4 py-3">
          <summary className="cursor-pointer text-[14px] font-medium text-muted select-none">{t('labels.grid')}</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1 text-[12.5px] text-muted">
              {t('labels.orientation')}
              <select
                value={profile.orientation}
                onChange={(e) => set({ orientation: e.target.value as SheetProfile['orientation'] })}
                className="h-11 rounded-xl border border-line-2 bg-[#0d1326] px-3 text-[15px] text-text"
              >
                <option value="landscape">{t('labels.landscape')}</option>
                <option value="portrait">{t('labels.portrait')}</option>
              </select>
            </label>
            {num(t('labels.rows'), profile.rows, 'rows', 1, 1, 30)}
            {num(t('labels.cols'), profile.cols, 'cols', 1, 1, 30)}
            {num(t('labels.marginTop'), profile.marginTop, 'marginTop')}
            {num(t('labels.marginBottom'), profile.marginBottom, 'marginBottom')}
            {num(t('labels.marginLeft'), profile.marginLeft, 'marginLeft')}
            {num(t('labels.marginRight'), profile.marginRight, 'marginRight')}
            {num(t('labels.gutterX'), profile.gutterX, 'gutterX', 0.5, 0, 30)}
            {num(t('labels.gutterY'), profile.gutterY, 'gutterY', 0.5, 0, 30)}
            {num(t('labels.qrSize'), profile.qrMm, 'qrMm', 0.5, 8, 60)}
          </div>
        </details>
        {canWrite && (
          <Button variant="accent" disabled={!draft} onClick={() => void save()}>
            <Save className="h-[18px] w-[18px]" aria-hidden />
            {t('labels.saveProfile')}
          </Button>
        )}
      </Card>
    </div>
  );
}

// ── NIIMBOT 20 × 20 mm ────────────────────────────────────────────────────────

function NiimbotLabel({ place }: { place: LabelItem }) {
  const { t } = useTranslation();
  const [png, setPng] = useState<{ url: string; blob: Blob } | null>(null);
  const text = shortLabelText(place.name);

  useEffect(() => {
    let url = '';
    let cancelled = false;
    void (async () => {
      await document.fonts.load('700 30px "Space Grotesk"').catch(() => undefined);
      const area = sq20TextArea();
      const bm = composeSq20(rawCodeQr(place.code), text ? rasterizeText(text, area.width, area.height) : null);
      const blob = new Blob([(await encodePng1bit(bm)) as BlobPart], { type: 'image/png' });
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setPng({ url, blob });
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [place.code, text]);

  return (
    <li className="glass flex flex-col items-center gap-2.5 rounded-[22px] p-3.5">
      <div className="flex aspect-square w-full max-w-[160px] items-center justify-center rounded-xl bg-white p-1.5">
        {png && <img src={png.url} alt={place.code} className="h-full w-full [image-rendering:pixelated]" />}
      </div>
      <div className="w-full min-w-0 text-center">
        <div className="truncate text-[14px] font-medium">{place.name}</div>
        <div className="tabular text-[11px] text-muted">{place.code}</div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={!png}
        onClick={() => png && download(png.blob, `${place.code.replace(/:/g, '-')}.png`, 'image/png')}
      >
        <Download className="h-4 w-4" aria-hidden />
        {t('labels.png')}
      </Button>
    </li>
  );
}

function NiimbotStudio({ places }: { places: LabelItem[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Card className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('labels.niimbotHint')}</Card>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {places.map((p) => (
          <NiimbotLabel key={p.id} place={p} />
        ))}
      </ul>
    </div>
  );
}
