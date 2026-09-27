import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, CircleAlert, Minus, Plus, Printer, RotateCcw, Tag, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import regularWoff from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff?url';
import boldWoff from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff?url';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { env } from '@/lib/env';
import {
  NIIMBOT_BATCHES,
  createSheets,
  detachTag,
  invalidateLabels,
  labelSheetsQuery,
  markPrinted,
  retireTag,
  sheetTagsQuery,
  tagErrorKey,
  tagState,
  tagTarget,
  type BlankFormat,
  type LabelSheet,
  type LabelTag,
} from '@/lib/labels/blank';
import type { PrintSheet } from '@/lib/labels/blankPrint';
import type { FontBytes } from '@/lib/labels/pdf';
import { DEFAULT_PROFILE, MINI_PROFILE, type SheetProfile } from '@/lib/labels/sheet';
import { MINI_PROFILE_NAME, PROFILE_NAME, labelProfileQuery } from '@/lib/places';
import { membershipQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/places/blank-labels')({
  component: BlankLabelsPage,
});

const FORMATS: BlankFormat[] = ['a4', 'a4mini', 'sq20', 'sq10'];
const isA4 = (f: BlankFormat) => f === 'a4' || f === 'a4mini';
/** Codes on staging / preview are test codes: they must never be stuck on a real box. */
const TEST_LABELS = env.VITE_APP_ENV !== 'prod';

function download(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
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
    return undefined;
  }
}

/** Blank label sheets (Phase 7b): print first, stick, and say what each label is on its first scan. */
function BlankLabelsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const membership = useQuery(membershipQuery);
  const householdId = membership.data?.household.id ?? '';
  const canWrite = membership.data ? membership.data.role !== 'viewer' : false;
  const sheets = useQuery({ ...labelSheetsQuery(householdId), enabled: Boolean(householdId) });
  const a4 = useQuery({ ...labelProfileQuery(householdId, PROFILE_NAME, DEFAULT_PROFILE), enabled: Boolean(householdId) });
  const mini = useQuery({ ...labelProfileQuery(householdId, MINI_PROFILE_NAME, MINI_PROFILE), enabled: Boolean(householdId) });

  const [format, setFormat] = useState<BlankFormat>('a4');
  const [count, setCount] = useState(1);
  const [batch, setBatch] = useState<number>(20);
  const [testOk, setTestOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<LabelSheet | null>(null);

  const profileFor = (f: BlankFormat): SheetProfile | undefined => (f === 'a4mini' ? mini.data?.profile : a4.data?.profile);
  const slotsFor = (f: BlankFormat) => {
    if (!isA4(f)) return batch;
    const p = profileFor(f);
    return p ? p.rows * p.cols : 0;
  };

  /** Print sheets (new or again): A4 → one PDF, NIIMBOT → one zip of PNGs. */
  async function print(list: PrintSheet[], f: BlankFormat) {
    const stamp = list.map((s) => s.sheetNo).join('-');
    if (isA4(f)) {
      const profile = profileFor(f);
      if (!profile) return;
      const { blankSheetPdf } = await import('@/lib/labels/blankPrint');
      const pdf = await blankSheetPdf({ profile, sheets: list, baseUrl: env.VITE_PUBLIC_BASE_URL, test: TEST_LABELS, fonts: await loadFonts() });
      download(pdf, `gedara-blank-${f}-sheet-${stamp}.pdf`, 'application/pdf');
    } else {
      const { blankPngZip } = await import('@/lib/labels/blankPrint');
      download(await blankPngZip(list, TEST_LABELS), `gedara-blank-${f}-sheet-${stamp}.zip`, 'application/zip');
    }
  }

  async function printNew() {
    const slots = slotsFor(format);
    if (!slots || slots > 300) return void toast.error(t('blank.errors.grid'));
    setBusy(true);
    try {
      const made = await createSheets(householdId, format, count, slots);
      const list: PrintSheet[] = [];
      for (const s of made) {
        const tags = await qc.fetchQuery(sheetTagsQuery(householdId, s.id));
        list.push({ sheetNo: s.sheet_no, format, tags });
      }
      await print(list, format);
      await Promise.all(made.map((s) => markPrinted(s.id)));
      toast.success(t('blank.made', { count: made.length, from: made[0]?.sheet_no, to: made.at(-1)?.sheet_no }));
    } catch (e) {
      toast.error(t(`blank.errors.${(e as { code?: string } | null)?.code === '42501' ? 'denied' : 'make'}`));
    } finally {
      await invalidateLabels(qc, householdId);
      setBusy(false);
    }
  }

  async function reprint(sheet: LabelSheet, onlyUnused: boolean) {
    setBusy(true);
    try {
      const tags = await qc.fetchQuery(sheetTagsQuery(householdId, sheet.id));
      const keep = onlyUnused ? tags.filter((x) => tagState(x) === 'blank') : tags;
      if (!keep.length) return void toast(t('blank.noneUnused'));
      await print([{ sheetNo: sheet.sheet_no, format: sheet.format, tags: keep }], sheet.format);
      await markPrinted(sheet.id);
      await invalidateLabels(qc, householdId);
    } catch {
      toast.error(t('labels.pdfFailed'));
    } finally {
      setBusy(false);
    }
  }

  const needsConfirm = TEST_LABELS && !testOk;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/places/labels" className="-mb-2 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('labels.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('blank.title')}</h1>
        <p className="mt-1 max-w-2xl text-[14.5px] text-muted">{t('blank.intro')}</p>
      </div>

      {TEST_LABELS && (
        <Card className="flex items-start gap-3 border-caution/40 p-4" data-testid="blank-test-warning">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-caution" aria-hidden />
          <div className="flex flex-col gap-2 text-[14px]">
            <p>{t('blank.testWarning')}</p>
            <label className="flex items-center gap-2.5 text-[13.5px]">
              <input type="checkbox" checked={testOk} onChange={(e) => setTestOk(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
              {t('blank.testOk')}
            </label>
          </div>
        </Card>
      )}

      {canWrite && (
        <Card className="flex flex-col gap-4 p-5">
          <h2 className="font-display text-[18px] font-semibold">{t('blank.printNew')}</h2>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('blank.format')}>
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => setFormat(f)}
                className={cn('h-10 rounded-xl border px-3.5 text-[14px]', format === f ? 'accent-pill border-transparent' : 'border-line-2 text-muted')}
              >
                {t(`blank.formats.${f}`)}
              </button>
            ))}
          </div>
          {!isA4(format) && (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <span className="text-muted">{t('blank.batch')}</span>
              {NIIMBOT_BATCHES.map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={batch === b}
                  onClick={() => setBatch(b)}
                  className={cn('tabular h-9 min-w-11 rounded-xl border px-3', batch === b ? 'accent-pill border-transparent' : 'border-line-2 text-muted')}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[14px] text-muted">{t('blank.howMany')}</span>
            <div className="flex items-center gap-2">
              <Button size="icon" aria-label={t('blank.fewer')} disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}>
                <Minus className="h-4 w-4" aria-hidden />
              </Button>
              <span className="tabular w-8 text-center text-[18px]" data-testid="blank-count">
                {count}
              </span>
              <Button size="icon" aria-label={t('blank.more')} disabled={count >= 10} onClick={() => setCount((c) => Math.min(10, c + 1))}>
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <span className="tabular text-[13px] text-muted">{t('blank.total', { count: count * slotsFor(format) })}</span>
          </div>
          <Button variant="primary" disabled={busy || needsConfirm || !slotsFor(format)} onClick={() => void printNew()} className="sm:self-start">
            <Printer className="h-[18px] w-[18px]" aria-hidden />
            {busy ? t('blank.making') : t('blank.printButton', { count })}
          </Button>
          <p className="text-[12.5px] leading-relaxed text-muted">{t(isA4(format) ? 'blank.a4Hint' : 'blank.niimbotHint')}</p>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5" data-testid="blank-sheets">
        <h2 className="font-display text-[18px] font-semibold">{t('blank.sheets')}</h2>
        {sheets.isPending ? (
          <div className="h-16 animate-pulse rounded-2xl bg-white/[0.04] motion-reduce:animate-none" aria-hidden />
        ) : !sheets.data?.length ? (
          <p className="text-[13.5px] text-muted">{t('blank.noSheets')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sheets.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/[0.03] px-3.5 py-3" data-testid="blank-sheet">
                <button type="button" onClick={() => setOpen(s)} className="min-w-0 flex-1 text-left">
                  <div className="font-display text-[16px] font-semibold">
                    {t('blank.sheetName', { n: s.sheet_no })} <span className="text-[13px] font-normal text-muted">· {t(`blank.formats.${s.format}`)}</span>
                  </div>
                  <div className="tabular text-[12.5px] text-muted">
                    {t('blank.counts', { unused: s.unused, used: s.used, retired: s.retired })}
                  </div>
                </button>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || needsConfirm} onClick={() => void reprint(s, false)}>
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    {t('blank.reprint')}
                  </Button>
                  {s.used + s.retired > 0 && s.unused > 0 && (
                    <Button size="sm" variant="ghost" disabled={busy || needsConfirm} onClick={() => void reprint(s, true)}>
                      {t('blank.reprintUnused')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && <SheetDetail sheet={open} householdId={householdId} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Every label of a sheet in its printed position: blank, in use (tap to open) or retired. */
function SheetDetail({ sheet, householdId, canWrite, onClose }: { sheet: LabelSheet; householdId: string; canWrite: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tags = useQuery(sheetTagsQuery(householdId, sheet.id));
  const [picked, setPicked] = useState<LabelTag | null>(null);
  const cols = sheet.format === 'a4' ? 9 : sheet.format === 'a4mini' ? 13 : 10;

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
      await invalidateLabels(qc, householdId);
      setPicked(null);
    } catch (e) {
      toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`));
    }
  }

  function openTarget(tag: LabelTag) {
    const target = tagTarget(tag);
    if (!target) return;
    onClose();
    if (target.kind === 'location') void navigate({ to: '/places/$placeId', params: { placeId: target.id } });
    else if (target.kind === 'asset') void navigate({ to: '/things/$assetId', params: { assetId: target.id } });
    else void navigate({ to: '/pantry/$productId', params: { productId: target.id } });
  }

  return (
    <Sheet open onClose={onClose} title={t('blank.sheetName', { n: sheet.sheet_no })}>
      <div className="flex flex-col gap-3">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {(tags.data ?? []).map((tag) => {
            const state = tagState(tag);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => setPicked(tag)}
                aria-label={`${tag.slot + 1}: ${t(`blank.state.${state}`)}`}
                className={cn(
                  'tabular flex aspect-square items-center justify-center rounded-md text-[10px]',
                  state === 'used' && 'bg-teal/25 text-teal',
                  state === 'blank' && 'border border-line-2 text-faint',
                  state === 'retired' && 'bg-red/15 text-red',
                )}
              >
                {state === 'retired' ? <X className="h-3 w-3" aria-hidden /> : tag.slot + 1}
              </button>
            );
          })}
        </div>
        {picked && (
          <Card className="flex flex-col gap-2.5 p-4">
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-accent-b" aria-hidden />
              <span className="tabular text-[13px]">{picked.code}</span>
              <span className="text-[12.5px] text-muted">· {t(`blank.state.${tagState(picked)}`)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {tagState(picked) === 'used' && (
                <Button size="sm" onClick={() => openTarget(picked)}>
                  {t('scan.open')}
                </Button>
              )}
              {canWrite && tagState(picked) === 'used' && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => detachTag(picked.code, tagTarget(picked)!.id))}>
                  {t('blank.detach')}
                </Button>
              )}
              {canWrite && tagState(picked) !== 'retired' && (
                <Button size="sm" variant="destructive" onClick={() => void act(() => retireTag(picked.code))}>
                  {t('blank.retire')}
                </Button>
              )}
            </div>
            {tagState(picked) !== 'retired' && <p className="text-[12.5px] text-muted">{t('blank.retireHint')}</p>}
          </Card>
        )}
      </div>
    </Sheet>
  );
}
