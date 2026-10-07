// Settings › Devices › Kitchen scales (Phase 6b). The owner adds a scale and gets its token ONCE (only
// the sha256 is kept), with the steps for the scale's own setup portal; everyone sees each scale's
// health and opens its page (calibration, sound, firmware, readings).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Copy, Scale, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { deviceOnline } from '@/lib/scale/format';
import { createScale, scaleErrorKey, scaleServerName, scalesQuery } from '@/lib/scale/queries';

function CopyToken({ token }: { token: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className={fieldLabel}>{t('scale.devices.token')}</div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-xl bg-black/25 px-3 py-2.5 font-mono text-[12.5px] break-all text-teal" data-testid="scale-token">
          {token}
        </code>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('scale.devices.copyToken')}
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

export function ScaleDevicesSection({ householdId, isOwner, locale, timezone }: { householdId: string; isOwner: boolean; locale: string; timezone: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const scales = useQuery({ ...scalesQuery(householdId), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const r = await createScale(householdId, name.trim());
      setCreated({ id: r.id, name: name.trim(), token: r.token });
      setName('');
      await qc.invalidateQueries({ queryKey: scalesQuery(householdId).queryKey });
    } catch (err) {
      toast.error(t(`scale.errors.${scaleErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  const active = (scales.data ?? []).filter((d) => !d.revoked_at);

  return (
    <section className="flex flex-col gap-3" data-testid="scale-devices">
      <h2 className="font-display text-[21px] font-semibold">{t('scale.devices.title')}</h2>
      <p className="-mt-1 text-[14px] text-muted">{t('scale.devices.intro')}</p>

      {created && (
        <Card className="flex flex-col gap-3.5 border-caution/40">
          <h3 className="font-display text-[18px] font-semibold">{t('scale.devices.setUpTitle', { name: created.name })}</h3>
          <p className="flex items-start gap-2 text-[13.5px] text-caution">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t('scale.devices.tokenOnce')}
          </p>
          <CopyToken token={created.token} />
          <ol className="list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-[#a5b0d0]">
            <li>{t('scale.devices.step1')}</li>
            <li>{t('scale.devices.step2')}</li>
            <li>{t('scale.devices.step3')}</li>
            <li>{t('scale.devices.step4', { server: scaleServerName() })}</li>
            <li>{t('scale.devices.step5')}</li>
          </ol>
          <Button variant="secondary" onClick={() => setCreated(null)}>
            {t('devices.doneCopying')}
          </Button>
        </Card>
      )}

      {isOwner && (
        <Card>
          <form className="flex flex-col gap-3" onSubmit={(e) => void add(e)}>
            <label className={fieldLabel} htmlFor="scale-name">
              {t('scale.devices.name')}
            </label>
            <Input
              id="scale-name"
              value={name}
              maxLength={40}
              placeholder={t('scale.devices.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant={active.length === 0 ? 'primary' : 'secondary'} disabled={busy || !name.trim()}>
              <Scale className="h-5 w-5" aria-hidden />
              {t('scale.devices.add')}
            </Button>
          </form>
        </Card>
      )}

      {active.length > 0 && (
        <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
          {active.map((d) => {
            const online = deviceOnline(d.last_seen_at);
            return (
              <li key={d.id}>
                <Link
                  to="/settings/scale/$deviceId"
                  params={{ deviceId: d.id }}
                  className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03]"
                >
                  <Scale className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="tabular text-[12.5px] text-muted">
                      {d.last_seen_at
                        ? t('scale.devices.stats', {
                            seen: when.format(new Date(d.last_seen_at)),
                            fw: d.fw_version ?? '—',
                            count: d.reading_count,
                          })
                        : t('scale.devices.notYet')}
                    </div>
                  </div>
                  <span className={`text-[12.5px] ${online ? 'text-teal' : 'text-faint'}`}>
                    {t(online ? 'scale.devices.online' : 'scale.devices.offline')}
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
