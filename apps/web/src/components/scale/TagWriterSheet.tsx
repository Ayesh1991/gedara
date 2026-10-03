// Write a container's NFC sticker from an Android phone (Web NFC, Phase 6b): one NDEF URL record
// https://gedara.vercel.app/s/HL:LOC:… — any phone opens the jar with a tap — and the sticker's UID is
// linked to the container so the scale knows it at once. A sticker already on another jar asks first.
import { useQueryClient } from '@tanstack/react-query';
import { Nfc } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { env } from '@/lib/env';
import { containerTagUrl, writeTag } from '@/lib/scale/nfc';
import { invalidateScale, linkTag, scaleErrorKey } from '@/lib/scale/queries';

type Phase = 'waiting' | 'linking' | 'taken' | 'done' | 'failed';

export function TagWriterSheet({
  open,
  onClose,
  householdId,
  locationId,
  code,
  name,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  locationId: string;
  code: string;
  name: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('waiting');
  const [uid, setUid] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    // Mounted only while open, so it starts at 'waiting' with no UID.
    if (!open) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    writeTag(containerTagUrl(env.VITE_PUBLIC_BASE_URL, code), ctrl.signal)
      .then(async (r) => {
        if (ctrl.signal.aborted) return;
        if (!r.uid) {
          // Written, but the phone didn't report the serial number: the scale links it by the URL.
          setPhase('done');
          return;
        }
        setUid(r.uid);
        setPhase('linking');
        try {
          await linkTag(locationId, r.uid);
          setPhase('done');
          await invalidateScale(qc, householdId);
        } catch (e) {
          if (scaleErrorKey(e) === 'tagTaken') setPhase('taken');
          else {
            toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
            setPhase('failed');
          }
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setPhase('failed');
      });
    return () => ctrl.abort();
  }, [open, code, locationId, householdId, qc, t]);

  async function moveHere() {
    if (!uid) return;
    try {
      await linkTag(locationId, uid, true);
      setPhase('done');
      await invalidateScale(qc, householdId);
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('scale.tag.writeTitle', { name })}>
      <div className="flex flex-col items-center gap-4 text-center" data-testid="tag-writer" data-phase={phase}>
        <span className="flex h-20 w-20 items-center justify-center rounded-3xl border border-line-2 bg-white/5 text-accent-b" aria-hidden>
          <Nfc className={phase === 'waiting' ? 'h-9 w-9 motion-safe:animate-pulse' : 'h-9 w-9'} />
        </span>
        <p className="text-[15px]">{t(`scale.tag.${phase}`, { name })}</p>
        {phase === 'taken' && (
          <Button variant="accent" onClick={() => void moveHere()}>
            {t('scale.tag.moveHere', { name })}
          </Button>
        )}
        {(phase === 'done' || phase === 'failed') && (
          <Button variant={phase === 'done' ? 'primary' : 'secondary'} onClick={onClose}>
            {t(phase === 'done' ? 'scale.tag.close' : 'common.close')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
