// Settings › Devices › Bin scanners (Phase 11). The owner adds a scanner and gets its key ONCE (only
// the sha256 is kept), with the steps for the scanner's own setup portal; everyone sees each
// scanner's health and opens its page (sound, scanner eye, firmware, log, pause).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Copy, ScanBarcode, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { scannerOnline } from '@/lib/scanner/format';
import { createScanner, scannerErrorKey, scannerServerName, scannersQuery } from '@/lib/scanner/queries';
import { useScannerLive } from './useScannerLive';

function CopyKey({ token }: { token: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className={fieldLabel}>{t('scanner.devices.token')}</div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-xl bg-black/25 px-3 py-2.5 font-mono text-[12.5px] break-all text-teal" data-testid="scanner-token">
          {token}
        </code>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('scanner.devices.copyToken')}
          onClick={() => {
            navigator.clipboard.writeText(token).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => toast.error(t('devices.copyFailed')),
            );
          }}
        >
          {copied ? <Check className="h-4 w-4 text-teal" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

export function ScannerDevicesSection({ householdId, isOwner, locale, timezone }: { householdId: string; isOwner: boolean; locale: string; timezone: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // Realtime keeps the rows fresh (no polling: the scanner itself only calls every 30 minutes when idle).
  const scanners = useQuery(scannersQuery(householdId));
  useScannerLive(householdId);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const r = await createScanner(householdId, name.trim());
      setCreated({ id: r.id, name: name.trim(), token: r.token });
      setName('');
      await qc.invalidateQueries({ queryKey: scannersQuery(householdId).queryKey });
    } catch (err) {
      toast.error(t(`scanner.errors.${scannerErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  const active = (scanners.data ?? []).filter((d) => !d.revoked_at);

  return (
    <section className="flex flex-col gap-3" data-testid="scanner-devices">
      <h2 className="font-display text-[21px] font-semibold">{t('scanner.devices.title')}</h2>
      <p className="-mt-1 text-[14px] text-muted">{t('scanner.devices.intro')}</p>

      {created && (
        <Card className="flex flex-col gap-3.5 border-caution/40">
          <h3 className="font-display text-[18px] font-semibold">{t('scanner.devices.setUpTitle', { name: created.name })}</h3>
          <p className="flex items-start gap-2 text-[13.5px] text-caution">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t('scanner.devices.tokenOnce')}
          </p>
          <CopyKey token={created.token} />
          <ol className="list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-[#a5b0d0]">
            <li>{t('scanner.devices.step1')}</li>
            <li>{t('scanner.devices.step2')}</li>
            <li>{t('scanner.devices.step3')}</li>
            <li>{t('scanner.devices.step4', { server: scannerServerName() })}</li>
            <li>{t('scanner.devices.step5')}</li>
          </ol>
          <Button variant="secondary" onClick={() => setCreated(null)}>
            {t('devices.doneCopying')}
          </Button>
        </Card>
      )}

      {isOwner && (
        <Card>
          <form className="flex flex-col gap-3" onSubmit={(e) => void add(e)}>
            <label className={fieldLabel} htmlFor="scanner-name">
              {t('scanner.devices.name')}
            </label>
            <Input
              id="scanner-name"
              value={name}
              maxLength={40}
              placeholder={t('scanner.devices.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>
              <ScanBarcode className="h-5 w-5" aria-hidden />
              {t('scanner.devices.add')}
            </Button>
          </form>
        </Card>
      )}

      {active.length > 0 && (
        <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
          {active.map((d) => {
            const online = scannerOnline(d.last_seen_at);
            return (
              <li key={d.id}>
                <Link to="/settings/scanner/$deviceId" params={{ deviceId: d.id }} className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03]">
                  <ScanBarcode className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="tabular text-[12.5px] text-muted">
                      {d.last_seen_at
                        ? t('scanner.devices.stats', { seen: when.format(new Date(d.last_seen_at)), fw: d.fw_version ?? '—', count: d.reading_count })
                        : t('scanner.devices.notYet')}
                    </div>
                  </div>
                  <span className={`text-[12.5px] ${d.paused_at ? 'text-caution' : online ? 'text-teal' : 'text-faint'}`}>
                    {t(d.paused_at ? 'scanner.devices.paused' : online ? 'scanner.devices.online' : 'scanner.devices.offline')}
                  </span>
                  <ChevronRight className="h-4 w-4 text-faint" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
