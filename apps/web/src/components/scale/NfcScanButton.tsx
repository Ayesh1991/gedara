// Scan screen on Android (Web NFC, Phase 6b): hold a container's sticker to the phone and it counts as
// a scan of the container's label — its URL record if written, else its UID looked up in nfc_tag.
// Listens until switched off, so stickers can be tapped one after another like barcodes.
import { Nfc } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { nfcSupported, readTag } from '@/lib/scale/nfc';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

async function codeForUid(uid: string): Promise<string | null> {
  const { data } = await supabase.from('nfc_tag').select('location:location(code)').eq('uid', uid).maybeSingle();
  const loc = (data as { location: { code: string } | { code: string }[] | null } | null)?.location;
  return Array.isArray(loc) ? (loc[0]?.code ?? null) : (loc?.code ?? null);
}

export function NfcScanButton({ onScan }: { onScan: (text: string) => void }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    const ctrl = new AbortController();
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const tag = await readTag(ctrl.signal);
          if (tag.url) onScan(tag.url);
          else if (tag.uid) {
            const code = await codeForUid(tag.uid);
            if (code) onScan(code);
            else toast(t('scale.nfc.unknown'));
          }
          await new Promise((r) => setTimeout(r, 800)); // the same sticker stays on the phone for a moment
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (e instanceof DOMException && e.name === 'NotAllowedError') {
            toast.error(t('scale.nfc.denied'));
            setOn(false);
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => ctrl.abort();
  }, [on, onScan, t]);

  if (!nfcSupported()) return null;
  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
      className={cn(
        'glass inline-flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[14px]',
        on && 'border-accent-a/60 text-accent-b',
      )}
    >
      <Nfc className={cn('h-4 w-4', on && 'motion-safe:animate-pulse')} aria-hidden />
      {t(on ? 'scale.nfc.listening' : 'scale.nfc.start')}
    </button>
  );
}
