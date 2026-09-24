import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlert, FileJson } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  BILL_FILE_TYPES,
  paidByCard,
  parseBillText,
  scannedToImport,
  type BillParseError,
  type ImportBill,
  type ScannedBill,
} from '@/lib/money/billSchema';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { formatLKR, sumAmounts } from '@/lib/money/format';
import {
  accountForMerchant,
  existingFingerprints,
  importBills,
  invalidateMoney,
  moneyErrorKey,
  pickableAccounts,
  rememberAccount,
  type Account,
} from '@/lib/money/queries';
import { formatDay } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AccountSelect, CategorySelect, fieldLabel } from './bits';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Draft {
  bill: ImportBill;
  scanned: ScannedBill;
  duplicate: boolean;
}

/** Bill-scanner JSON → preview (account per bill, category per line) → one Import. */
export function BillImport({
  householdId,
  locale,
  today,
  accounts,
  categories,
}: {
  householdId: string;
  locale: string;
  today: string;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setTextRaw] = useState('');
  const [fileError, setFileError] = useState<{ kind: 'type' | 'size' } | null>(null);
  // Per-bill edits (account, categories), valid only for the text they were made on.
  const [edited, setEdited] = useState<{ text: string; bills: ImportBill[] } | null>(null);
  const [existing, setExisting] = useState<{ text: string; fps: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);

  const setText = (next: string) => {
    setFileError(null);
    setTextRaw(next);
  };

  const suspense = accounts.find((a) => a.is_suspense && !a.archived);
  const cash = accounts.find((a) => a.kind === 'cash' && !a.archived && !a.is_suspense);
  const choices = pickableAccounts(accounts).concat(suspense ? [suspense] : []);

  function defaultAccount(b: ScannedBill): string {
    const remembered = accountForMerchant(b.shop || b.store);
    if (remembered && choices.some((a) => a.id === remembered)) return remembered;
    if (paidByCard(b.payment_method)) return suspense?.id ?? choices[0]!.id;
    return cash?.id ?? choices[0]!.id;
  }

  // Parse on every change of the text (paste, or a file's contents).
  const parsed = useMemo(() => (text.trim() ? parseBillText(text) : null), [text]);
  const built = useMemo(
    () =>
      parsed && 'bills' in parsed
        ? parsed.bills.map((scanned) => ({ scanned, bill: scannedToImport(scanned, categories, defaultAccount(scanned)) }))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- account defaults are read once per parse
    [parsed, categories],
  );

  // Which of these bills are already in Gedara ("Already imported").
  useEffect(() => {
    if (!built) return;
    let cancelled = false;
    existingFingerprints(householdId, built.map((d) => d.bill.fingerprint)).then(
      (fps) => !cancelled && setExisting({ text, fps }),
      () => !cancelled && setExisting({ text, fps: new Set() }),
    );
    return () => {
      cancelled = true;
    };
  }, [built, householdId, text]);

  const error: BillParseError | { kind: 'type' | 'size' } | null = fileError ?? (parsed && 'error' in parsed ? parsed.error : null);
  const bills = edited?.text === text ? edited.bills : built?.map((d) => d.bill);
  const drafts: Draft[] | null =
    built && bills && existing?.text === text
      ? built.map((d, i) => ({ scanned: d.scanned, bill: bills[i]!, duplicate: existing.fps.has(d.bill.fingerprint) }))
      : null;

  async function readFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    // Trust the content, not the name: only JSON/plain-text MIME types, and the text is sniffed.
    if (list.some((f) => !BILL_FILE_TYPES.includes(f.type))) return setFileError({ kind: 'type' });
    if (list.some((f) => f.size > MAX_FILE_BYTES)) return setFileError({ kind: 'size' });
    const texts = await Promise.all(list.map(async (f) => (await f.text()).replace(/^\uFEFF/, '').trim()));
    if (texts.length === 1) return setText(texts[0]!);
    // Several files → one array of bills (a file that isn't JSON is shown as-is so its error appears).
    const values: unknown[] = [];
    for (const raw of texts) {
      try {
        const v: unknown = JSON.parse(raw);
        values.push(...(Array.isArray(v) ? v : [v]));
      } catch {
        return setText(raw);
      }
    }
    setText(JSON.stringify(values, null, 2));
  }

  function update(i: number, patch: (d: Draft) => Draft) {
    if (!drafts) return;
    setEdited({ text, bills: drafts.map((d, j) => (j === i ? patch(d) : d).bill) });
  }

  const toImport = drafts?.filter((d) => !d.duplicate) ?? [];

  async function doImport() {
    if (!toImport.length || busy) return;
    if (toImport.some((d) => d.bill.lines.some((l) => !l.category_id))) {
      toast.error(t('money.form.needCategory'));
      return;
    }
    setBusy(true);
    try {
      const results = await importBills(householdId, toImport.map((d) => d.bill));
      for (const d of toImport) {
        if (d.bill.account_id !== suspense?.id) rememberAccount(d.bill.account_id, d.bill.payee_text);
      }
      const imported = results.filter((r) => r.status === 'imported').length;
      await invalidateMoney(qc, householdId);
      toast.success(t('money.import.done', { count: imported, skipped: results.length - imported }));
      const first = toImport[0]!.bill.occurred_on.slice(0, 7);
      void navigate({ to: '/money', search: { month: first } });
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('money.import.billHelp')}</p>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-line-2 px-4 py-5 text-[14.5px] text-muted hover:text-text">
          <FileJson className="h-5 w-5" aria-hidden />
          {t('money.import.pickJson')}
          <input
            type="file"
            accept=".json,application/json,text/plain"
            multiple
            className="sr-only"
            onChange={(e) => void readFiles(e.target.files)}
          />
        </label>
        <label htmlFor="bill-json" className={fieldLabel}>
          {t('money.import.paste')}
        </label>
        <textarea
          id="bill-json"
          rows={5}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"shop": "…", "date": "2026-09-24", "items": [ … ], "total": 0}'
          className="tabular w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[13px] text-text focus:border-accent-a focus:outline-none"
        />
        {error && (
          <p className="flex items-start gap-2 text-[14px] text-red" role="alert">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t(`money.import.errors.${error.kind}`, {
              message: 'message' in error ? error.message : '',
              index: 'index' in error ? error.index + 1 : 1,
            })}
          </p>
        )}
      </Card>

      {drafts?.map((d, i) => (
        <Card key={d.bill.fingerprint + i} className={cn('flex flex-col gap-3', d.duplicate && 'opacity-60')}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-display text-[17px] font-semibold">{d.bill.payee_text || t('money.import.noShop')}</h3>
              <p className="tabular text-[13px] text-muted">
                {[formatDay(d.bill.occurred_on, locale, today.slice(0, 4)), d.bill.occurred_at, d.bill.invoice_no && `#${d.bill.invoice_no}`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="text-right">
              <div className="tabular text-[17px]">{formatLKR(d.bill.total)}</div>
              {d.duplicate && (
                <span className="tabular rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted">{t('money.import.already')}</span>
              )}
            </div>
          </div>
          {!d.duplicate && (
            <>
              <div>
                <label className={fieldLabel} htmlFor={`bill-acc-${i}`}>
                  {t('money.form.paidWith')}
                  {d.scanned.payment_method ? ` (${d.scanned.payment_method})` : ''}
                </label>
                <AccountSelect
                  id={`bill-acc-${i}`}
                  accounts={choices}
                  value={d.bill.account_id}
                  onChange={(id) => update(i, (x) => ({ ...x, bill: { ...x.bill, account_id: id } }))}
                />
              </div>
              <ul className="flex flex-col gap-2">
                {d.bill.lines.map((l, j) => (
                  <li key={l.fingerprint} className="flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={cn('min-w-0 truncate text-[14px]', l.synthetic && 'text-muted italic')}>{l.raw_name}</span>
                      <span className="tabular shrink-0 text-[14px]">{formatLKR(l.amount)}</span>
                    </div>
                    <CategorySelect
                      kind="expense"
                      categories={categories}
                      value={l.category_id}
                      className={cn('h-10 text-[14px]', l.guessed && 'border-caution/50')}
                      onChange={(id) =>
                        update(i, (x) => ({
                          ...x,
                          bill: { ...x.bill, lines: x.bill.lines.map((y, k) => (k === j ? { ...y, category_id: id, guessed: false } : y)) },
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
              {d.bill.lines.some((l) => l.synthetic) && (
                <p className="text-[12.5px] text-muted">
                  {t('money.import.adjusted', {
                    lines: formatLKR(sumAmounts(d.bill.lines.filter((l) => !l.synthetic).map((l) => l.amount))),
                  })}
                </p>
              )}
            </>
          )}
        </Card>
      ))}

      {drafts && (
        <Button variant="primary" disabled={busy || toImport.length === 0} onClick={() => void doImport()}>
          {toImport.length === 0
            ? t('money.import.nothingNew')
            : t('money.import.importBills', { count: toImport.length, total: formatLKR(sumAmounts(toImport.map((d) => d.bill.total))) })}
        </Button>
      )}
    </div>
  );
}
