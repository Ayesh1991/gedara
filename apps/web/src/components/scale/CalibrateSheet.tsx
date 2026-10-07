// Calibration wizard (Phase 6b). While open, the scale polls every second (rpc_device_watch) and sends
// its live weight, so each step shows what the scale sees: 1 · empty → Zero, 2 · a known weight →
// Calibrate (the scale computes and saves its factor in its own memory), 3 · check with something else.
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { parseQty } from '@/lib/pantry/units';
import { deviceOnline, formatGrams } from '@/lib/scale/format';
import { scaleErrorKey, scalesQuery, sendCommand, waitForCommand, watchScale, type ScaleCommand } from '@/lib/scale/queries';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3;

export function CalibrateSheet({ open, onClose, householdId, deviceId }: { open: boolean; onClose: () => void; householdId: string; deviceId: string }) {
  const { t } = useTranslation();
  const scales = useQuery({ ...scalesQuery(householdId), refetchInterval: open ? 2000 : false });
  const device = scales.data?.find((d) => d.id === deviceId);
  const [step, setStep] = useState<Step>(1);
  const [known, setKnown] = useState('1000');
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!open) return;
    void watchScale(deviceId, 10).catch(() => undefined);
    return () => void watchScale(deviceId, 0).catch(() => undefined);
  }, [open, deviceId]);

  // Sends a command and moves the wizard on when the scale says it's done.
  async function send(kind: ScaleCommand, args: Record<string, unknown> = {}) {
    setWaiting(true);
    try {
      const id = await sendCommand(deviceId, kind, args);
      const status = await waitForCommand(id);
      if (status === 'done') setStep(kind === 'tare' ? 2 : 3);
      else toast.error(t('scale.calibrate.failed'));
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    } finally {
      setWaiting(false);
    }
  }

  const online = deviceOnline(device?.last_seen_at ?? null);
  // In watch mode every sync carries the live weight: fresh = sent with the latest sync.
  const liveFresh =
    !!device?.live_at && !!device.last_seen_at && Date.parse(device.last_seen_at) - Date.parse(device.live_at) < 5000;
  const knownG = parseQty(known);

  return (
    <Sheet open={open} onClose={onClose} title={t('scale.calibrate.title')}>
      <div className="flex flex-col gap-4" data-testid="calibrate" data-step={step}>
        <ol className="flex gap-2" aria-label={t('scale.calibrate.steps')}>
          {([1, 2, 3] as const).map((s) => (
            <li
              key={s}
              className={cn(
                'flex h-8 flex-1 items-center justify-center rounded-xl border text-[13px]',
                s < step ? 'border-teal/40 text-teal' : s === step ? 'border-accent-a/60 text-text' : 'border-line text-faint',
              )}
            >
              {s < step ? <Check className="h-4 w-4" aria-hidden /> : s}
            </li>
          ))}
        </ol>

        <div className="glass flex items-center justify-between rounded-2xl px-4 py-3">
          <span className="text-[13.5px] text-muted">{t(online ? 'scale.calibrate.sees' : 'scale.calibrate.connecting')}</span>
          <span className="tabular font-display text-[26px] font-semibold" data-testid="calibrate-live">
            {liveFresh && device?.live_gross_g != null ? formatGrams(device.live_gross_g) : '—'}
          </span>
        </div>

        <p className="text-[15px] leading-relaxed">{t(`scale.calibrate.step${step}`)}</p>

        {step === 2 && (
          <div>
            <label className={fieldLabel} htmlFor="known-g">
              {t('scale.calibrate.known')}
            </label>
            <Input id="known-g" inputMode="decimal" value={known} onChange={(e) => setKnown(e.target.value)} className="max-w-[160px]" />
            <p className="mt-1.5 text-[12.5px] text-faint">{t('scale.calibrate.knownHint')}</p>
          </div>
        )}

        {step === 1 && (
          <Button variant="primary" disabled={waiting} onClick={() => void send('tare')}>
            {waiting && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
            {t('scale.calibrate.zero')}
          </Button>
        )}
        {step === 2 && (
          <Button
            variant="primary"
            disabled={waiting || knownG === null || knownG < 50 || knownG > 5000}
            onClick={() => void send('calibrate', { known_g: knownG })}
          >
            {waiting && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
            {t('scale.calibrate.calibrate')}
          </Button>
        )}
        {step === 3 && (
          <Button variant="primary" onClick={onClose}>
            {t('scale.calibrate.finish')}
          </Button>
        )}
        {waiting && <p className="text-[13px] text-muted">{t('scale.calibrate.waiting')}</p>}
      </div>
    </Sheet>
  );
}
