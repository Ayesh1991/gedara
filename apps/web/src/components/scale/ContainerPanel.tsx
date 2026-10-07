// The kitchen-scale side of a container's page (Phase 6b): what it holds, its empty weight ("Weigh
// empty" on the scale, or typed), its NFC tag (written from an Android phone, or linked from the
// scale), a weight typed by hand, and its last weighings. Shown for places of kind 'container' and
// for any place that already holds a product.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Nfc, Scale, Tag, Trash } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { parseQty } from '@/lib/pantry/units';
import { formatDelta, formatGrams } from '@/lib/scale/format';
import { nfcSupported } from '@/lib/scale/nfc';
import {
  armWeighEmpty,
  containerQuery,
  invalidateScale,
  readingsQuery,
  scaleErrorKey,
  setContainer,
  unlinkTag,
  weighByHand,
} from '@/lib/scale/queries';
import { ProductChooser } from './ProductChooser';
import { TagWriterSheet } from './TagWriterSheet';
import { useScaleLive } from './useScaleLive';

export function ContainerPanel({
  householdId,
  placeId,
  kind,
  canWrite,
  locale,
  timezone,
}: {
  householdId: string;
  placeId: string;
  kind: string | null;
  canWrite: boolean;
  locale: string;
  timezone: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const c = useQuery(containerQuery(householdId, placeId));
  const readings = useQuery(readingsQuery(householdId, { locationId: placeId, limit: 5 }));
  const [typing, setTyping] = useState(false);
  const [tare, setTare] = useState('');
  const [byHand, setByHand] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "Weigh empty" countdown, and the live answer from the scale.
  const armedUntil = c.data?.scale_setup_until ? Date.parse(c.data.scale_setup_until) : 0;
  const armed = armedUntil > now;
  useEffect(() => {
    if (!armed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [armed]);
  useScaleLive(householdId, (r) => {
    if (r.location_id === placeId && r.status === 'tare_set') {
      toast.success(t('scale.container.tareSaved', { tare: formatGrams(r.result.tare_g as number) }));
    }
  });

  if (c.isPending || !c.data) return null;
  const jar = c.data;
  if (kind !== 'container' && !jar.holds_product_id) return null;

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });

  async function run(fn: () => Promise<unknown>, ok?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await invalidateScale(qc, householdId);
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  function saveTare(e: FormEvent) {
    e.preventDefault();
    const g = parseQty(tare);
    if (g === null || g < 0 || g > 5000) {
      toast.error(t('scale.errors.invalid'));
      return;
    }
    void run(() => setContainer(placeId, { tare_g: g }), t('scale.container.tareSaved', { tare: formatGrams(g) })).then(() => {
      setTyping(false);
      setTare('');
    });
  }

  function saveByHand(e: FormEvent) {
    e.preventDefault();
    const g = parseQty(byHand);
    if (g === null || g < 0) {
      toast.error(t('scale.errors.invalid'));
      return;
    }
    void run(async () => {
      const r = await weighByHand(placeId, g);
      toast.success(
        t(`scale.status.${r.status}`, { left: formatGrams(r.left_g ?? g), pending: '', moved: '', gross: '', tare: '', container: jar.name }),
      );
    }).then(() => setByHand(''));
  }

  return (
    <Card className="flex flex-col gap-4" data-testid="container-panel">
      <div className="flex items-center gap-2.5">
        <Scale className="h-5 w-5 text-accent-b" aria-hidden />
        <h2 className="flex-1 font-display text-[19px] font-semibold">{t('scale.container.title')}</h2>
      </div>

      <ProductChooser
        householdId={householdId}
        id={`holds-${placeId}`}
        value={jar.holds_product_id}
        disabled={!canWrite || busy}
        onChange={(p) => void run(() => setContainer(placeId, { holds_product_id: p }), t('scale.container.saved'))}
      />

      <div className="flex flex-col gap-2">
        <div className={fieldLabel}>{t('scale.container.empty')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular text-[17px]" data-testid="container-tare">
            {jar.tare_g !== null ? formatGrams(jar.tare_g) : t('scale.container.notSet')}
          </span>
          {canWrite && (
            <>
              {armed ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => armWeighEmpty(placeId, false))}>
                  {t('scale.container.cancelWeighEmpty')}
                </Button>
              ) : (
                <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => armWeighEmpty(placeId))}>
                  <Scale className="h-4 w-4" aria-hidden />
                  {t('scale.container.weighEmpty')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setTyping((v) => !v)}>
                {t('scale.container.typeIt')}
              </Button>
            </>
          )}
        </div>
        {armed && (
          <p className="text-[13.5px] text-info" role="status">
            {t('scale.container.armed', { seconds: Math.max(0, Math.round((armedUntil - now) / 1000)) })}
          </p>
        )}
        {typing && (
          <form className="flex gap-2" onSubmit={saveTare}>
            <Input
              inputMode="decimal"
              value={tare}
              onChange={(e) => setTare(e.target.value)}
              placeholder={t('scale.container.tarePlaceholder')}
              aria-label={t('scale.container.empty')}
              className="max-w-[160px]"
            />
            <Button type="submit" size="md" disabled={busy}>
              {t('scale.container.save')}
            </Button>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className={fieldLabel}>{t('scale.container.tag')}</div>
        <div className="flex flex-wrap items-center gap-2">
          {jar.tag ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[13px]" data-testid="container-tag">
              <Tag className="h-4 w-4 text-teal" aria-hidden />
              {jar.tag.uid}
            </span>
          ) : (
            <span className="text-[14px] text-muted">{t('scale.container.noTag')}</span>
          )}
          {canWrite && nfcSupported() && (
            <Button size="sm" variant="accent" onClick={() => setWriting(true)}>
              <Nfc className="h-4 w-4" aria-hidden />
              {t(jar.tag ? 'scale.container.rewrite' : 'scale.container.writeTag')}
            </Button>
          )}
          {canWrite && jar.tag && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('scale.container.removeTagConfirm'))) void run(() => unlinkTag(jar.tag!.id));
              }}
            >
              <Trash className="h-4 w-4" aria-hidden />
              {t('scale.container.removeTag')}
            </Button>
          )}
        </div>
        {!jar.tag && <p className="text-[12.5px] text-faint">{t(nfcSupported() ? 'scale.container.tagHintNfc' : 'scale.container.tagHint')}</p>}
      </div>

      {canWrite && jar.holds_product_id && jar.tare_g !== null && (
        <form className="flex flex-col gap-2" onSubmit={saveByHand}>
          <label className={fieldLabel} htmlFor={`byhand-${placeId}`}>
            {t('scale.container.byHand')}
          </label>
          <div className="flex gap-2">
            <Input
              id={`byhand-${placeId}`}
              inputMode="decimal"
              value={byHand}
              onChange={(e) => setByHand(e.target.value)}
              placeholder={t('scale.container.byHandPlaceholder')}
              className="max-w-[160px]"
            />
            <Button type="submit" disabled={busy || !byHand.trim()}>
              {t('scale.container.record')}
            </Button>
          </div>
        </form>
      )}

      {(readings.data?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className={fieldLabel}>{t('scale.container.lastWeighings')}</div>
          <ul className="divide-y divide-line text-[13.5px]">
            {readings.data!.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-1.5">
                <span className="tabular w-32 shrink-0 text-muted">{when.format(new Date(r.at))}</span>
                <span className="min-w-0 flex-1 truncate">{t(`scale.short.${r.status}`)}</span>
                {r.delta_g !== null && ['consumed', 'refilled', 'needs_decision', 'decided'].includes(r.status) && (
                  <span className="tabular">{formatDelta(r.delta_g)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {writing && (
        <TagWriterSheet
          open={writing}
          onClose={() => setWriting(false)}
          householdId={householdId}
          locationId={placeId}
          code={jar.code}
          name={jar.name}
        />
      )}
    </Card>
  );
}
