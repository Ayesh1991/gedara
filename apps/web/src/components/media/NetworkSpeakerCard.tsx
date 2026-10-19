// The speaker as a plain network speaker (Phase 7i): AirPlay for iPhone / iPad / Mac and Bluetooth
// for Android and PCs, so YouTube Music or any app can play on it. The speaker is invisible to
// Bluetooth and refuses pairing except for the 2 minutes after "Let a phone or PC pair"; paired
// devices reconnect by themselves and can be removed here.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Airplay, Bluetooth, BluetoothOff, Radio, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  btDevicesQuery,
  invalidateMedia,
  mediaErrorKey,
  sendMediaCommand,
  updateSpeaker,
  waitForMediaCommand,
  type Speaker,
} from '@/lib/media/queries';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

const PAIR_SECONDS = 120;

export function NetworkSpeakerCard({ speaker, online, canWrite }: { speaker: Speaker; online: boolean; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const devices = useQuery(btDevicesQuery(speaker.household_id));
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const st = speaker.status ?? {};
  const airplay = speaker.settings?.airplay ?? true;
  const bluetooth = speaker.settings?.bluetooth ?? true;
  const noAdapter = st.bluetooth === 'none';
  const left = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  const mine = (devices.data ?? []).filter((d) => d.device_id === speaker.id);

  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) setUntil(null);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  async function setSetting(key: 'airplay' | 'bluetooth', value: boolean) {
    try {
      await updateSpeaker(speaker.id, { settings: { [key]: value } });
      await invalidateMedia(qc, speaker.household_id, 'speakers');
      toast.success(t('music.speaker.saved'));
    } catch (e) {
      toast.error(t(mediaErrorKey(e)));
    }
  }

  async function command(name: 'bt_pair' | 'bt_forget', args: Record<string, unknown> = {}) {
    try {
      const id = await sendMediaCommand(speaker.id, name, args);
      if (name === 'bt_pair') {
        setNow(Date.now());
        setUntil(Date.now() + PAIR_SECONDS * 1000);
      }
      const outcome = await waitForMediaCommand(id, 8000);
      if (outcome !== 'done') {
        toast.error(t('music.errors.noAnswer'));
        if (name === 'bt_pair') setUntil(null);
      } else if (name === 'bt_forget') {
        await invalidateMedia(qc, speaker.household_id, 'bt');
      }
    } catch (e) {
      toast.error(t(mediaErrorKey(e)));
    }
  }

  return (
    <Card className="flex flex-col gap-5" data-testid="network-speaker">
      <div className="flex items-center gap-3">
        <Radio className="h-5 w-5 text-accent-b" aria-hidden />
        <h2 className="flex-1 font-display text-[18px] font-semibold">{t('music.network.title')}</h2>
      </div>
      <p className="-mt-2 text-[13.5px] text-muted">{t('music.network.intro')}</p>

      <div className="flex items-start gap-3">
        <Airplay className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium">{t('music.network.airplay')}</div>
          <div className="text-[13px] text-muted">{airplay ? t('music.network.airplayOn', { name: speaker.name }) : t('music.network.off')}</div>
        </div>
        <Toggle on={airplay} disabled={!canWrite} onChange={(v) => void setSetting('airplay', v)} label={t('music.network.airplay')} />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          {noAdapter ? <BluetoothOff className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden /> : <Bluetooth className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium">{t('music.network.bluetooth')}</div>
            <div className="text-[13px] text-muted">
              {noAdapter ? t('music.network.noAdapter') : bluetooth ? t('music.network.bluetoothOn', { name: speaker.name }) : t('music.network.off')}
            </div>
          </div>
          {!noAdapter && <Toggle on={bluetooth} disabled={!canWrite} onChange={(v) => void setSetting('bluetooth', v)} label={t('music.network.bluetooth')} />}
        </div>

        {!noAdapter && bluetooth && canWrite && (
          <div className="ml-8 flex flex-col gap-2">
            {left > 0 ? (
              <div className="rounded-2xl border border-[color-mix(in_srgb,var(--accent-b)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent-b)_10%,transparent)] px-4 py-3 text-[14px]" data-testid="bt-pairing">
                <div className="tabular font-medium">{t('music.network.pairingOpen', { s: left })}</div>
                <div className="text-[13px] text-muted">{t('music.network.pairingHow', { name: speaker.name })}</div>
              </div>
            ) : (
              <Button variant="secondary" className="self-start" disabled={!online} onClick={() => void command('bt_pair')}>
                <Bluetooth className="h-4 w-4" aria-hidden />
                {t('music.network.pair')}
              </Button>
            )}
            {mine.length > 0 && (
              <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
                {mine.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', d.connected ? 'bg-teal shadow-[0_0_8px_var(--teal)]' : 'bg-white/20')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px]">{d.name}</span>
                      <span className="block text-[12px] text-faint">{d.connected ? t('music.network.connected') : t('music.network.paired')}</span>
                    </span>
                    <Button size="icon" variant="ghost" disabled={!online} aria-label={t('music.network.forget', { name: d.name })} onClick={() => void command('bt_forget', { address: d.address })}>
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <p className="text-[12.5px] text-faint">{t('music.network.noCast')}</p>
    </Card>
  );
}
