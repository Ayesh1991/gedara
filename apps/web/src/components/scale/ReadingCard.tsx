// One kitchen-scale reading as a card: what happened ("Sugar −24 g · 788 g left"), how long it took
// to arrive, and what you can do about it — Undo, the refill question (Move from pantry / Count
// correction / Later), linking an unknown tag. Used by the pop-ups and the Kitchen-scale page.
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleHelp, Scale, Tag, TriangleAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { undoStock } from '@/lib/pantry/queries';
import { formatDelta, formatGrams, formatLatency, latencyMs, statusTone, type Tone } from '@/lib/scale/format';
import { decideReading, invalidateScale, scaleErrorKey, type Decision, type ScaleReading } from '@/lib/scale/queries';
import { cn } from '@/lib/utils';
import { LinkTagSheet } from './LinkTagSheet';
import { arrivedAt } from './useScaleLive';

const TONE: Record<Tone, string> = {
  teal: 'border-teal/40',
  info: 'border-info/45',
  caution: 'border-caution/45',
  red: 'border-red/50',
  muted: 'border-line-2',
};
const DELTA_TONE: Record<Tone, string> = {
  teal: 'text-teal',
  info: 'text-info',
  caution: 'text-caution',
  red: 'text-red',
  muted: 'text-muted',
};

export function readingTitle(r: ScaleReading, fallback: string): string {
  return r.result.name ?? r.result.container ?? fallback;
}

export function ReadingCard({
  reading,
  householdId,
  canWrite,
  big,
  onHandled,
  className,
}: {
  reading: ScaleReading;
  householdId: string;
  canWrite: boolean;
  big?: boolean;
  onHandled?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [linking, setLinking] = useState(false);
  const r = reading;
  const tone = statusTone(r.status);
  const shown = arrivedAt(r.id);
  const latency = shown ? latencyMs(r.at, shown, r.time_estimated) : null;
  const left = typeof r.result.left_g === 'number' ? r.result.left_g : null;
  const undoCorrelation = r.status === 'decided' ? (r.decision?.correlation_id ?? null) : r.correlation_id;
  const canUndo = canWrite && !undone && !!undoCorrelation && ['consumed', 'refilled', 'decided', 'needs_decision'].includes(r.status);

  async function undo() {
    if (!undoCorrelation || busy) return;
    setBusy(true);
    try {
      await undoStock(undoCorrelation);
      setUndone(true);
      toast.success(t('scale.card.undone'));
      await invalidateScale(qc, householdId);
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  async function decide(choice: Decision) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await decideReading(r.id, choice);
      if (choice !== 'later') toast.success(t('scale.card.decidedToast', { left: formatGrams(res.left_g) }));
      await invalidateScale(qc, householdId);
      onHandled?.();
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  const delta =
    r.status === 'consumed' || r.status === 'refilled' || r.status === 'needs_decision' || r.status === 'decided'
      ? (r.delta_g ?? 0)
      : null;

  return (
    <div
      className={cn('glass flex flex-col gap-3 rounded-[var(--r)] border p-4', TONE[tone], className)}
      data-testid="scale-reading"
      data-status={r.status}
    >
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5', DELTA_TONE[tone])} aria-hidden>
          {r.status === 'unknown_tag' ? (
            <Tag className="h-[18px] w-[18px]" />
          ) : r.status === 'needs_decision' ? (
            <CircleHelp className="h-[18px] w-[18px]" />
          ) : tone === 'caution' || tone === 'red' ? (
            <TriangleAlert className="h-[18px] w-[18px]" />
          ) : (
            <Scale className="h-[18px] w-[18px]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('flex flex-wrap items-baseline gap-x-2 font-display font-semibold', big ? 'text-[28px]' : 'text-[17px]')}>
            <span className="min-w-0 truncate" data-testid="scale-reading-title">
              {readingTitle(r, t('scale.card.unknownJar'))}
            </span>
            {delta !== null && (
              <span className={cn('tabular', DELTA_TONE[tone])} data-testid="scale-reading-delta">
                {formatDelta(delta)}
              </span>
            )}
          </div>
          <p className={cn('text-muted', big ? 'text-[15px]' : 'text-[13px]')}>
            {t(`scale.status.${r.status}`, {
              left: left !== null ? formatGrams(left) : '',
              pending: formatGrams(r.pending_g ?? 0),
              moved: formatGrams(Math.abs(r.moved_g ?? 0)),
              gross: formatGrams(r.gross_g ?? 0),
              tare: formatGrams(r.tare_g ?? 0),
              container: r.result.container ?? '',
            })}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {left !== null && r.status !== 'unknown_tag' && (
            <span className={cn('tabular font-semibold', big ? 'text-[20px]' : 'text-[14px]')} data-testid="scale-reading-left">
              {t('scale.card.left', { left: formatGrams(left) })}
            </span>
          )}
          {latency !== null && (
            <span className="tabular text-[11.5px] text-faint" title={t('scale.card.latencyHint')}>
              {formatLatency(latency)}
            </span>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {r.status === 'needs_decision' && (
            <>
              <Button size="sm" variant="accent" disabled={busy} onClick={() => void decide('transfer')}>
                {t('scale.card.movePantry')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void decide('adjust')}>
                {t('scale.card.countCorrection')}
              </Button>
              {!r.decision?.later_at && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('later')}>
                  {t('scale.card.later')}
                </Button>
              )}
            </>
          )}
          {r.status === 'unknown_tag' && r.uid && (
            <Button size="sm" variant="accent" onClick={() => setLinking(true)}>
              <Tag className="h-4 w-4" aria-hidden />
              {t('scale.card.linkTag')}
            </Button>
          )}
          {(r.status === 'no_tare' || r.status === 'no_product' || r.status === 'below_tare') && r.location_id && (
            <Link
              to="/places/$placeId"
              params={{ placeId: r.location_id }}
              className="inline-flex h-9 items-center rounded-xl px-3 text-sm text-accent-b hover:bg-white/5"
            >
              {t('scale.card.openJar')}
            </Link>
          )}
          {canUndo && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()} className="ml-auto">
              <Undo2 className="h-4 w-4" aria-hidden />
              {t('common.undo')}
            </Button>
          )}
          {undone && <span className="ml-auto self-center text-[12.5px] text-muted">{t('scale.card.undone')}</span>}
        </div>
      )}

      {linking && r.uid && (
        <LinkTagSheet
          open={linking}
          onClose={() => setLinking(false)}
          householdId={householdId}
          uid={r.uid}
          grossG={r.gross_g}
          onLinked={() => {
            setLinking(false);
            onHandled?.();
          }}
        />
      )}
    </div>
  );
}
