// Settings › Devices › Music speakers (Phase 7h). Adding a speaker: run the installer on the PC,
// which shows an 8-digit code; type it here. No key is ever shown or copied (the Pi made its own).
// Everyone sees each speaker's health and opens its page (volume limit, schedules, test sound).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Plus, Speaker as SpeakerIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { invalidateMedia, mediaErrorKey, pairSpeaker, speakerOnline, speakersQuery } from '@/lib/media/queries';

/** "48291736" → "4829 1736" while typing. */
export function formatPairCode(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
}

function PairSheet({ open, onClose, householdId }: { open: boolean; onClose: () => void; householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(t('music.devices.defaultName'));
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const digits = code.replace(/\D/g, '');

  async function pair(e: FormEvent) {
    e.preventDefault();
    if (busy || digits.length !== 8 || !name.trim()) return;
    setBusy(true);
    setWrong(false);
    try {
      const r = await pairSpeaker(householdId, digits, name.trim());
      if (!r.ok) {
        setWrong(true);
        return;
      }
      toast.success(t('music.devices.paired', { name: name.trim() }));
      await invalidateMedia(qc, householdId, 'speakers');
      setCode('');
      onClose();
    } catch (err) {
      toast.error(t(mediaErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('music.devices.addTitle')}>
      <ol className="flex flex-col gap-2.5 text-[14px] leading-relaxed text-[#a5b0d0]">
        <li>
          <span className="tabular mr-2 text-accent-b">1</span>
          {t('music.devices.step1')}
        </li>
        <li>
          <code className="block rounded-xl bg-black/30 px-3 py-2.5 font-mono text-[12.5px] break-all text-teal">
            powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -Music
          </code>
        </li>
        <li>
          <span className="tabular mr-2 text-accent-b">2</span>
          {t('music.devices.step2')}
        </li>
      </ol>
      <form onSubmit={pair} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.devices.code')}</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={formatPairCode(code)}
            onChange={(e) => {
              setCode(e.target.value);
              setWrong(false);
            }}
            placeholder="0000 0000"
            aria-invalid={wrong}
            aria-describedby={wrong ? 'pair-wrong' : undefined}
            data-testid="pair-code"
            className="tabular h-16 rounded-2xl border border-line-2 bg-black/25 text-center text-[30px] tracking-[0.18em] outline-none focus:border-accent-b"
          />
          {wrong && (
            <span id="pair-wrong" role="alert" className="text-[13px] text-red">
              {t('music.errors.wrongCode')}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('music.devices.name')}</span>
          <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" disabled={busy || digits.length !== 8 || !name.trim()}>
          {t('music.devices.pair')}
        </Button>
      </form>
    </Sheet>
  );
}

export function SpeakerDevicesSection({ householdId, isOwner }: { householdId: string; isOwner: boolean }) {
  const { t } = useTranslation();
  const speakers = useQuery({ ...speakersQuery(householdId), refetchInterval: 30_000 });
  const [adding, setAdding] = useState(false);
  const list = speakers.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <h2 className="font-display text-[21px] font-semibold">{t('music.devices.title')}</h2>
          <p className="mt-1 text-[14px] text-muted">{t('music.devices.intro')}</p>
        </div>
        {isOwner && list.length < 2 && (
          <Button variant="accent" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('music.devices.add')}
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <Card className="text-[14px] text-muted">{t('music.devices.none')}</Card>
      ) : (
        <Card className="flex flex-col divide-y divide-line p-0">
          {list.map((s) => {
            const online = speakerOnline(s);
            return (
              <Link
                key={s.id}
                to="/settings/speaker/$deviceId"
                params={{ deviceId: s.id }}
                className="flex items-center gap-3 px-5 py-4 hover:bg-white/[0.03]"
                data-testid="speaker-row"
              >
                <span className="brand-gradient flex h-10 w-10 items-center justify-center rounded-xl text-[#05070F]">
                  <SpeakerIcon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] font-medium">{s.name}</span>
                  <span className="block text-[13px] text-muted">
                    <span className={online ? 'text-teal' : 'text-caution'}>{online ? t('music.devices.online') : t('music.devices.offline')}</span>
                    {s.status?.output ? ` · ${t(`music.devices.output.${s.status.output}`)}` : ''}
                    {s.fw_version ? ` · ${s.fw_version}` : ''}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 text-faint" aria-hidden />
              </Link>
            );
          })}
        </Card>
      )}
      {adding && <PairSheet open onClose={() => setAdding(false)} householdId={householdId} />}
    </section>
  );
}
