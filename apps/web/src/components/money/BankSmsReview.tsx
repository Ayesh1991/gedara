import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, MessageSquareText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { parseScanText, type BankSmsDoc } from '@/lib/money/billSchema';
import { formatLKR } from '@/lib/money/format';
import { invalidateMoney } from '@/lib/money/queries';
import { invalidateScan, markScanFileDone } from '@/lib/scan/queries';
import { smsQuery, uploadBackup } from '@/lib/sms/queries';
import { alreadyIn, parseRow, screenshotRows, toBackup, type ShotRow } from '@/lib/sms/screenshot';
import { cn } from '@/lib/utils';

const inputClass =
  'tabular h-10 rounded-xl border border-line-2 bg-white/5 px-2.5 text-[14px] text-text focus:border-accent-a focus:outline-none';

/**
 * Bank alerts copied from a screenshot by the Bill Scanner (Phase 7c): check each one's day, leave
 * out what already arrived, and add the rest to the SMS inbox — where they are reviewed like any
 * forwarded alert. Nothing goes into the ledger from here.
 */
export function BankSmsReview({
  householdId,
  docs,
  fileTime,
  fileId,
  onDone,
}: {
  householdId: string;
  docs: BankSmsDoc[];
  /** When the file reached Drive (or now, for pasted JSON): the base day when the scanner saw none. */
  fileTime: Date;
  /** A Drive file (marked done afterwards). */
  fileId?: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const inbox = useQuery(smsQuery(householdId));
  const [rows, setRows] = useState<ShotRow[]>(() => screenshotRows(docs, fileTime));
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<number | null>(null);

  const checked = useMemo(
    () =>
      rows.map((row) => {
        const p = parseRow(row);
        const dup = 'sms' in p && alreadyIn(p.sms, inbox.data ?? []);
        return { row, p, dup, defaultOn: 'sms' in p && !dup };
      }),
    [rows, inbox.data],
  );
  const isOn = (key: string, fallback: boolean) => picked[key] ?? fallback;
  const chosen = checked.filter((c) => 'sms' in c.p && isOn(c.row.key, c.defaultOn));

  const edit = (key: string, patch: Partial<ShotRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, guessed: patch.date !== undefined ? false : r.guessed } : r)));

  async function add() {
    const messages = chosen.map((c) => toBackup(c.row)).filter((m): m is NonNullable<typeof m> => m !== null);
    if (!messages.length) return;
    setBusy(true);
    try {
      const r = await uploadBackup(householdId, messages);
      if (fileId) await markScanFileDone(fileId);
      await Promise.all([invalidateMoney(qc, householdId), invalidateScan(qc, householdId)]);
      setAdded(r.stored);
      toast.success(t('smsShot.added', { count: r.stored }), {
        description: r.duplicate ? t('smsShot.duplicates', { count: r.duplicate }) : undefined,
      });
    } catch {
      toast.error(t('smsShot.failed'));
    } finally {
      setBusy(false);
    }
  }

  if (added !== null) {
    return (
      <Card className="flex flex-col items-start gap-3 p-5" data-testid="sms-shot-done">
        <div className="flex items-center gap-2 text-[15px]">
          <CircleCheck className="h-5 w-5 text-teal" aria-hidden />
          {t('smsShot.addedLong', { count: added })}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/money/inbox" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            {t('smsShot.review')}
          </Link>
          {onDone && (
            <Button size="sm" variant="ghost" onClick={onDone}>
              {t('scanInbox.back')}
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sms-shot">
      <Card className="flex items-start gap-3 p-4">
        <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-accent-b" aria-hidden />
        <div className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('smsShot.intro')}</div>
      </Card>
      <ul className="flex flex-col gap-2.5">
        {checked.map(({ row, p, dup, defaultOn }) => {
          const on = 'sms' in p && isOn(row.key, defaultOn);
          return (
            <li key={row.key} data-testid="sms-shot-row">
              <Card className={cn('flex flex-col gap-2.5 p-4', !on && 'opacity-70')}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!('sms' in p)}
                    onChange={(e) => setPicked((x) => ({ ...x, [row.key]: e.target.checked }))}
                    aria-label={t('smsShot.include')}
                    className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent-a)]"
                  />
                  <div className="min-w-0 flex-1">
                    {'sms' in p ? (
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                        <span className="font-display text-[15px] font-semibold">{p.sms.sender}</span>
                        <span className="text-[13px] text-muted">{t(`money.inbox.kinds.${p.sms.kind}`)}</span>
                        {p.sms.amount !== null && <span className="tabular text-[15px]">{formatLKR(p.sms.amount)}</span>}
                        {p.sms.balance_after !== null && (
                          <span className="tabular text-[12.5px] text-muted">{t('smsShot.balance', { amount: formatLKR(p.sms.balance_after) })}</span>
                        )}
                      </div>
                    ) : (
                      <div className="font-display text-[15px] font-semibold">{row.sender || '—'}</div>
                    )}
                    <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{row.body}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-8">
                  <input
                    type="date"
                    value={row.date ?? ''}
                    onChange={(e) => edit(row.key, { date: e.target.value || null })}
                    aria-label={t('smsShot.date')}
                    className={cn(inputClass, row.guessed && 'border-caution/60')}
                  />
                  <input
                    type="time"
                    value={row.time ?? ''}
                    onChange={(e) => edit(row.key, { time: e.target.value || null })}
                    aria-label={t('smsShot.time')}
                    className={inputClass}
                  />
                  {row.guessed && <span className="text-[12px] text-caution">{t('smsShot.checkDate')}</span>}
                  {dup && (
                    <span className="flex items-center gap-1 text-[12px] text-teal" data-testid="sms-shot-dup">
                      <CircleCheck className="h-3.5 w-3.5" aria-hidden />
                      {t('smsShot.already')}
                    </span>
                  )}
                  {'reason' in p && (
                    <span className="flex items-center gap-1 text-[12px] text-caution">
                      <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                      {t(`smsShot.left.${p.reason === 'otp' || p.reason === 'sender' || p.reason === 'noDate' ? p.reason : 'other'}`)}
                    </span>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <Button variant="primary" disabled={busy || chosen.length === 0 || inbox.isPending} onClick={() => void add()} className="sm:self-start">
        {busy ? t('smsShot.adding') : t('smsShot.add', { count: chosen.length })}
      </Button>
    </div>
  );
}

/**
 * Money › Import › Bank SMS: paste what the Bill Scanner wrote for a screenshot of the bank's SMS
 * thread (or it arrives from the Android share sheet), then review it as above.
 */
export function SmsScreenshotPaste({ householdId, initialText }: { householdId: string; initialText?: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText ?? '');
  const [docs, setDocs] = useState<BankSmsDoc[] | null>(() => (initialText ? readDocs(initialText) : null));
  const [error, setError] = useState<string | null>(null);

  function read() {
    const r = parseScanText(text);
    if ('error' in r) return setError(t(`money.import.errors.${r.error.kind}`, { message: 'message' in r.error ? r.error.message : '', index: 'index' in r.error ? r.error.index + 1 : 1 }));
    if (r.kind !== 'bank_sms') return setError(t('smsShot.notSms'));
    setError(null);
    setDocs(r.docs);
  }

  if (docs) return <BankSmsReview householdId={householdId} docs={docs} fileTime={new Date()} onDone={() => setDocs(null)} />;

  return (
    <Card className="flex flex-col gap-3 p-5" data-testid="sms-shot-paste">
      <div className="flex items-start gap-3">
        <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-accent-b" aria-hidden />
        <div>
          <h2 className="font-display text-[17px] font-semibold">{t('smsShot.pasteTitle')}</h2>
          <p className="mt-0.5 text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('smsShot.pasteHint')}</p>
        </div>
      </div>
      <textarea
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={t('smsShot.pasteLabel')}
        placeholder='{"doc_type": "bank_sms", "messages": [ … ]}'
        className="tabular w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[13px] text-text focus:border-accent-a focus:outline-none"
      />
      {error && (
        <p className="flex items-start gap-2 text-[14px] text-red" role="alert">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <Button size="sm" disabled={!text.trim()} onClick={read} className="self-start">
        {t('smsShot.read')}
      </Button>
    </Card>
  );
}

function readDocs(text: string): BankSmsDoc[] | null {
  const r = parseScanText(text);
  return 'kind' in r && r.kind === 'bank_sms' ? r.docs : null;
}

/** Is this scanner text a bank SMS screenshot (so the share sheet opens the Bank SMS tab)? */
export function isBankSmsText(text: string | undefined): boolean {
  return Boolean(text && readDocs(text));
}
