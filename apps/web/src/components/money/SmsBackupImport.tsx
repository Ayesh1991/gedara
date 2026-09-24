import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, MessageSquareText, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { invalidateMoney } from '@/lib/money/queries';
import { checkBackupFile, scanBackup, type BackupError, type BackupScan } from '@/lib/sms/backupXml';
import { uploadBackup, type BackupUploadResult } from '@/lib/sms/queries';
import { fieldLabel } from './bits';

const dayMs = (day: string, end = false) => Date.parse(`${day}T${end ? '23:59:59.999' : '00:00:00'}+05:30`);
const colomboDay = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

/**
 * "SMS Backup & Restore" XML → bank alerts only → review inbox. Everything except received alerts
 * from the four bank senders is discarded in the browser; OTPs never leave the device.
 */
export function SmsBackupImport({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<BackupError | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BackupUploadResult | null>(null);

  const scan = useMemo((): BackupScan | null => {
    if (!text) return null;
    const r = scanBackup(text, { from: from ? dayMs(from) : undefined, to: to ? dayMs(to, true) : undefined });
    return 'error' in r ? null : r;
  }, [text, from, to]);

  async function readFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setResult(null);
    const bad = checkBackupFile(f);
    if (bad) {
      setText(null);
      return setError(bad);
    }
    const content = await f.text();
    const r = scanBackup(content);
    if ('error' in r) {
      setText(null);
      return setError(r.error);
    }
    setError(null);
    setText(content);
  }

  async function upload() {
    if (!scan || progress || scan.messages.length === 0) return;
    setProgress({ done: 0, total: scan.messages.length });
    try {
      const r = await uploadBackup(householdId, scan.messages, (done) => setProgress({ done, total: scan.messages.length }));
      setResult(r);
      await invalidateMoney(qc, householdId);
    } catch {
      toast.error(t('money.import.smsFailed'));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('money.import.smsHelp')}</p>
        <p className="flex items-start gap-2 text-[13px] text-teal">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t('money.import.smsPrivacy')}
        </p>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-line-2 px-4 py-5 text-[14.5px] text-muted hover:text-text">
          <MessageSquareText className="h-5 w-5" aria-hidden />
          {t('money.import.pickXml')}
          <input type="file" accept=".xml,text/xml,application/xml" className="sr-only" onChange={(e) => void readFile(e.target.files)} />
        </label>
        {error && (
          <p className="flex items-start gap-2 text-[14px] text-red" role="alert">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t(`money.import.smsErrors.${error}`)}
          </p>
        )}
      </Card>

      {scan && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-display text-[17px] font-semibold">{t('money.import.found')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={fieldLabel} htmlFor="sms-from">
                {t('money.import.smsFrom')}
              </label>
              <Input id="sms-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="sms-to">
                {t('money.import.smsTo')}
              </label>
              <Input id="sms-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <ul className="flex flex-col gap-1 text-[14px]">
            {Object.entries(scan.bySender).map(([bank, n]) => (
              <li key={bank} className="flex justify-between">
                <span>{bank}</span>
                <span className="tabular">{n}</span>
              </li>
            ))}
          </ul>
          {scan.first !== null && scan.last !== null && (
            <p className="tabular text-[13px] text-muted">
              {t('money.import.smsRange', { from: colomboDay(scan.first), to: colomboDay(scan.last) })}
            </p>
          )}
          <p className="text-[13px] text-muted">
            {t('money.import.smsDropped', {
              others: scan.dropped.otherSenders,
              secret: scan.dropped.secret,
              promo: scan.dropped.promo,
              sent: scan.dropped.sent,
            })}
          </p>
          <Button variant="primary" disabled={!!progress || scan.messages.length === 0} onClick={() => void upload()}>
            {progress
              ? t('money.import.smsUploading', { done: progress.done, total: progress.total })
              : t('money.import.smsUpload', { count: scan.messages.length })}
          </Button>
        </Card>
      )}

      {result && (
        <Card className="flex flex-col gap-3" role="status">
          <p className="flex items-start gap-2 text-[14.5px]">
            <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden />
            {t('money.import.smsDone', { stored: result.stored, duplicate: result.duplicate })}
          </p>
          <Link to="/money/inbox" className={buttonVariants({ variant: 'accent' })}>
            {t('money.inbox.open')}
          </Link>
        </Card>
      )}
    </div>
  );
}
