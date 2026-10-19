// Settings › Devices › Home Assistant (Phase 8). Connecting: run the installer on the PC with
// -HomeAssistant; the Pi asks for Home Assistant's address and token itself (they never come here)
// and shows an 8-digit code, typed here by the owner. Everyone sees the bridge's health; the owner
// opens its page to choose what the House page shows and controls.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, HousePlug, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatPairCode } from '@/components/media/SpeakerDevicesSection';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { bridgeOnline, bridgeQuery, homeErrorKey, invalidateHome, pairBridge } from '@/lib/home/queries';

function PairSheet({ onClose, householdId }: { onClose: () => void; householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(t('house.devices.defaultName'));
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const digits = code.replace(/\D/g, '');

  async function pair(e: FormEvent) {
    e.preventDefault();
    if (busy || digits.length !== 8 || !name.trim()) return;
    setBusy(true);
    setWrong(false);
    try {
      const r = await pairBridge(householdId, digits, name.trim());
      if (!r.ok) {
        setWrong(true);
        return;
      }
      toast.success(t('house.devices.paired'));
      await invalidateHome(qc, householdId);
      onClose();
    } catch (err) {
      toast.error(t(homeErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={t('house.devices.addTitle')}>
      <ol className="flex flex-col gap-2.5 text-[14px] leading-relaxed text-[#a5b0d0]">
        <li>
          <span className="tabular mr-2 text-accent-b">1</span>
          {t('house.devices.step1')}
        </li>
        <li>
          <span className="tabular mr-2 text-accent-b">2</span>
          {t('house.devices.step2')}
        </li>
        <li>
          <code className="block rounded-xl bg-black/30 px-3 py-2.5 font-mono text-[12.5px] break-all text-teal">
            powershell -ExecutionPolicy Bypass -File devices/print-server/install.ps1 -HomeAssistant
          </code>
        </li>
        <li>
          <span className="tabular mr-2 text-accent-b">3</span>
          {t('house.devices.step3')}
        </li>
      </ol>
      <form onSubmit={pair} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('house.devices.code')}</span>
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
            aria-describedby={wrong ? 'ha-pair-wrong' : undefined}
            data-testid="ha-pair-code"
            className="tabular h-16 rounded-2xl border border-line-2 bg-black/25 text-center text-[30px] tracking-[0.18em] outline-none focus:border-accent-b"
          />
          {wrong && (
            <span id="ha-pair-wrong" role="alert" className="text-[13px] text-red">
              {t('house.errors.wrongCode')}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t('house.devices.name')}</span>
          <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" disabled={busy || digits.length !== 8 || !name.trim()}>
          {t('house.devices.connect')}
        </Button>
      </form>
    </Sheet>
  );
}

export function HomeAssistantSection({ householdId, isOwner }: { householdId: string; isOwner: boolean }) {
  const { t } = useTranslation();
  const bridge = useQuery({ ...bridgeQuery(householdId), refetchInterval: 30_000 });
  const [adding, setAdding] = useState(false);
  const b = bridge.data;
  const online = bridgeOnline(b);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <h2 className="font-display text-[21px] font-semibold">{t('house.devices.title')}</h2>
          <p className="mt-1 text-[14px] text-muted">{t('house.devices.intro')}</p>
        </div>
        {isOwner && !b && !bridge.isPending && (
          <Button variant="accent" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('house.devices.add')}
          </Button>
        )}
      </div>
      {!b ? (
        <Card className="text-[14px] text-muted">{t('house.devices.none')}</Card>
      ) : (
        <Card className="p-0">
          <Link
            to="/settings/home-assistant"
            className="flex items-center gap-3 px-5 py-4 hover:bg-white/[0.03]"
            data-testid="bridge-row"
          >
            <span className="brand-gradient flex h-10 w-10 items-center justify-center rounded-xl text-[#05070F]">
              <HousePlug className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15.5px] font-medium">{b.name}</span>
              <span className="block text-[13px] text-muted">
                <span className={online ? 'text-teal' : 'text-caution'}>{online ? t('house.bridge.online') : t('house.bridge.offline')}</span>
                {b.status?.ha && online ? ` · ${t(`house.bridge.haShort.${b.status.ha}`)}` : ''}
                {b.fw_version ? ` · ${b.fw_version}` : ''}
              </span>
            </span>
            <ChevronRight className="h-5 w-5 text-faint" aria-hidden />
          </Link>
        </Card>
      )}
      {adding && <PairSheet onClose={() => setAdding(false)} householdId={householdId} />}
    </section>
  );
}
