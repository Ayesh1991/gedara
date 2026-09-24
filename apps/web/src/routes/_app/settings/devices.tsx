import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Check, ChevronLeft, Copy, Smartphone, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FORWARD_SENDERS, FORWARD_TEXT_REGEX } from '@sms/parse';
import { EmptyState } from '@/components/aurora/EmptyState';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { moneyErrorKey } from '@/lib/money/queries';
import { createDevice, devicesQuery, ingestUrl, revokeDevice, type Device } from '@/lib/sms/queries';

export const Route = createFileRoute('/_app/settings/devices')({
  component: DevicesPage,
});

const SENDER_REGEX = `^(${FORWARD_SENDERS.join('|')})$`;
const BODY_TEMPLATE = '{"from":"%from%","text":"%text%","sentStamp":%sentStamp%,"receivedStamp":%receivedStamp%}';

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('devices.copyFailed'));
    }
  };
  return (
    <div>
      <div className={fieldLabel}>{label}</div>
      <div className="flex items-start gap-2">
        <code
          className={`min-w-0 flex-1 rounded-xl bg-black/25 px-3 py-2.5 font-mono text-[12.5px] break-all ${secret ? 'text-teal' : 'text-text'}`}
        >
          {value}
        </code>
        <Button size="icon" variant="ghost" aria-label={t('devices.copy', { what: label })} onClick={() => void copy()}>
          {copied ? <Check className="h-4 w-4 text-teal" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

function DevicesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const isOwner = membership.role === 'owner';
  // Polls while the page is open, so "last seen" updates as soon as the phone sends its first alert.
  const devices = useQuery({ ...devicesQuery(householdId), refetchInterval: 10_000 });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const dateTime = new Intl.DateTimeFormat(membership.household.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: membership.household.timezone,
  });
  const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : t('devices.never'));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const r = await createDevice(householdId, name.trim());
      setCreated({ name: name.trim(), token: r.token });
      setName('');
      await qc.invalidateQueries({ queryKey: devicesQuery(householdId).queryKey });
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(d: Device) {
    if (!window.confirm(t('devices.revokeConfirm', { name: d.name }))) return;
    try {
      await revokeDevice(d.id);
      toast.success(t('devices.revoked', { name: d.name }));
      await qc.invalidateQueries({ queryKey: devicesQuery(householdId).queryKey });
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    }
  }

  const active = (devices.data ?? []).filter((d) => !d.revoked_at);
  const revoked = (devices.data ?? []).filter((d) => d.revoked_at);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('devices.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('devices.intro')}</p>
      </div>

      {created && (
        <Card className="flex flex-col gap-3.5 border-caution/40">
          <h2 className="font-display text-[18px] font-semibold">{t('devices.setUpTitle', { name: created.name })}</h2>
          <p className="flex items-start gap-2 text-[13.5px] text-caution">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t('devices.tokenOnce')}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-[#a5b0d0]">
            <li>{t('devices.step1')}</li>
            <li>{t('devices.step2')}</li>
            <li>{t('devices.step3')}</li>
            <li>{t('devices.step4')}</li>
          </ol>
          <CopyField label={t('devices.url')} value={ingestUrl()} />
          <CopyField label={t('devices.headers')} value={JSON.stringify({ 'X-Gedara-Device': created.token })} secret />
          <CopyField label={t('devices.template')} value={BODY_TEMPLATE} />
          <CopyField label={t('devices.senderRegex')} value={SENDER_REGEX} />
          <CopyField label={t('devices.textRegex')} value={FORWARD_TEXT_REGEX} />
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null);
              void qc.invalidateQueries({ queryKey: devicesQuery(householdId).queryKey });
            }}
          >
            {t('devices.doneCopying')}
          </Button>
        </Card>
      )}

      {isOwner ? (
        <Card>
          <form className="flex flex-col gap-3" onSubmit={(e) => void add(e)}>
            <label className={fieldLabel} htmlFor="device-name">
              {t('devices.name')}
            </label>
            <Input
              id="device-name"
              value={name}
              maxLength={40}
              placeholder={t('devices.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              <Smartphone className="h-5 w-5" aria-hidden />
              {t('devices.add')}
            </Button>
          </form>
        </Card>
      ) : (
        <Card className="text-[14px] text-muted">{t('devices.ownerOnly')}</Card>
      )}

      {devices.isPending ? (
        <div className="glass h-24 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : active.length === 0 && !created ? (
        <EmptyState icon={Smartphone} title={t('devices.emptyTitle')} body={t('devices.emptyBody')} />
      ) : (
        <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
          {active.map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Smartphone className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                <span className="font-mono text-[12px] text-faint">…{d.token_hint}</span>
                {isOwner && (
                  <Button size="sm" variant="destructive" onClick={() => void revoke(d)}>
                    {t('devices.revoke')}
                  </Button>
                )}
              </div>
              <div className="tabular text-[12.5px] text-muted">
                {t('devices.stats', { seen: when(d.last_seen_at), stored: d.message_count, dropped: d.dropped_count })}
              </div>
              {d.last_rejected_sender && (
                <div className="text-[12.5px] text-caution">
                  {t('devices.rejected', { sender: d.last_rejected_sender, when: when(d.last_rejected_at) })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && <p className="text-[12.5px] text-faint">{t('devices.revokedCount', { count: revoked.length })}</p>}
    </div>
  );
}
