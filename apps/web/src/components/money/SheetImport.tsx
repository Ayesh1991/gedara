import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, FileSpreadsheet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { formatAmount, formatLKR, sumAmounts } from '@/lib/money/format';
import {
  importBills,
  invalidateMoney,
  linesByMonth,
  moneyErrorKey,
  pickableAccounts,
  type Account,
} from '@/lib/money/queries';
import {
  monthTotals,
  parseSheetCsv,
  sheetBillToImport,
  type SheetParse,
  type SheetParseError,
} from '@/lib/money/sheetImport';
import { formatMonth } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AccountSelect } from './bits';

const CSV_TYPES = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv', ''];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Default account for a Sheet `paid_by` value: cards wait in "to be matched". */
function guessAccount(paidBy: string, accounts: Account[]): string | null {
  const p = paidBy.toLowerCase();
  const find = (f: (a: Account) => boolean) => accounts.find((a) => !a.archived && f(a))?.id ?? null;
  if (p.includes('card')) return find((a) => a.is_suspense) ?? find((a) => a.kind === 'credit_card');
  if (p.includes('cash') || p === '') return find((a) => a.kind === 'cash');
  if (p.includes('bank') || p.includes('online')) return find((a) => a.kind === 'bank');
  return find((a) => a.kind === 'cash');
}

interface Reconciliation {
  months: Array<{ month: string; sheet: number; skipped: number; gedara: number }>;
  linesFound: number;
  linesExpected: number;
}

/** Ledger v7 Google-Sheet CSV → preview + paid_by mapping → import → reconciliation to the rupee. */
export function SheetImport({
  householdId,
  locale,
  accounts,
  categories,
}: {
  householdId: string;
  locale: string;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<SheetParse | null>(null);
  const [error, setError] = useState<SheetParseError | { kind: 'type' | 'size' } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ imported: number; duplicate: number } | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);

  const choices = useMemo(() => {
    const suspense = accounts.filter((a) => a.is_suspense && !a.archived);
    return [...pickableAccounts(accounts), ...suspense];
  }, [accounts]);
  const months = parsed ? monthTotals(parsed) : [];
  const lineCount = parsed?.bills.reduce((n, b) => n + b.rows.length, 0) ?? 0;

  async function readFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setResult(null);
    setRecon(null);
    if (!CSV_TYPES.includes(f.type)) return setError({ kind: 'type' });
    if (f.size > MAX_FILE_BYTES) return setError({ kind: 'size' });
    const p = parseSheetCsv(await f.text());
    if ('error' in p) {
      setParsed(null);
      setError(p.error);
      return;
    }
    setError(null);
    setParsed(p);
    setMapping(Object.fromEntries(p.paidByValues.map((v) => [v, guessAccount(v, accounts) ?? ''])));
  }

  async function reconcile(p: SheetParse) {
    const lineIds = p.bills.flatMap((b) => b.rows.map((r) => r.id));
    const { months: found, found: linesFound } = await linesByMonth(lineIds);
    setRecon({
      months: monthTotals(p).map((m) => ({ month: m.month, sheet: sumAmounts([m.imported, m.skipped]), skipped: m.skipped, gedara: found.get(m.month) ?? 0 })),
      linesFound,
      linesExpected: lineIds.length,
    });
  }

  async function doImport() {
    if (!parsed || progress) return;
    if (parsed.paidByValues.some((v) => !mapping[v])) {
      toast.error(t('money.form.needAccount'));
      return;
    }
    const bills = parsed.bills.map((b) => sheetBillToImport(b, categories, (paidBy) => mapping[paidBy]!));
    setProgress({ done: 0, total: bills.length });
    try {
      const results = await importBills(householdId, bills, (done) => setProgress({ done, total: bills.length }));
      const imported = results.filter((r) => r.status === 'imported').length;
      setResult({ imported, duplicate: results.length - imported });
      await invalidateMoney(qc, householdId);
      await reconcile(parsed);
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setProgress(null);
    }
  }

  const reconOk = recon && recon.linesFound === recon.linesExpected && recon.months.every((m) => sumAmounts([m.gedara, m.skipped]) === m.sheet);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('money.import.sheetHelp')}</p>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-line-2 px-4 py-5 text-[14.5px] text-muted hover:text-text">
          <FileSpreadsheet className="h-5 w-5" aria-hidden />
          {t('money.import.pickCsv')}
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void readFile(e.target.files)} />
        </label>
        {error && (
          <p className="flex items-start gap-2 text-[14px] text-red" role="alert">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t(`money.import.sheetErrors.${error.kind}`, {
              missing: 'missing' in error ? error.missing.join(', ') : '',
              line: 'line' in error ? error.line : 0,
              message: 'message' in error ? error.message : '',
            })}
          </p>
        )}
      </Card>

      {parsed && (
        <>
          <Card className="flex flex-col gap-3">
            <h3 className="font-display text-[17px] font-semibold">{t('money.import.found')}</h3>
            <div className="grid grid-cols-3 gap-2.5">
              {[
                [t('money.import.rows'), parsed.rowsRead],
                [t('money.import.billsFound'), parsed.bills.length],
                [t('money.import.linesFound'), lineCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-white/[0.04] px-3 py-2.5">
                  <div className="tabular text-[20px]">{value}</div>
                  <div className="text-[12.5px] text-muted">{label}</div>
                </div>
              ))}
            </div>
            {parsed.skipped.length > 0 && (
              <details className="rounded-2xl border border-line-2 px-4 py-3">
                <summary className="cursor-pointer text-[14px]">
                  {t('money.import.skipped', { count: parsed.skipped.length, total: formatLKR(sumAmounts(parsed.skipped.map((s) => s.amount))) })}
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
                  {parsed.skipped.map((s) => (
                    <li key={s.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {s.date} · {s.item || s.id} — <span className="text-muted">{t(`money.import.skipReasons.${s.reason}`)}</span>
                      </span>
                      <span className="tabular shrink-0">{formatAmount(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          <Card className="flex flex-col gap-3">
            <h3 className="font-display text-[17px] font-semibold">{t('money.import.mapping')}</h3>
            <p className="text-[13.5px] text-muted">{t('money.import.mappingHelp')}</p>
            {parsed.paidByValues.map((v) => (
              <div key={v} className="grid grid-cols-[1fr_1.3fr] items-center gap-3">
                <span className="truncate text-[14px]">
                  {v || t('money.import.blank')}{' '}
                  <span className="tabular text-muted">({parsed.bills.filter((b) => b.paidBy === v).length})</span>
                </span>
                <AccountSelect
                  accounts={choices}
                  value={mapping[v] || null}
                  onChange={(id) => setMapping((m) => ({ ...m, [v]: id }))}
                  className="h-11"
                />
              </div>
            ))}
          </Card>

          <Card className="p-0">
            <table className="w-full text-[14px]">
              <caption className="px-5 pt-4 pb-2 text-left font-display text-[17px] font-semibold">
                {recon ? t('money.import.reconciliation') : t('money.import.byMonth')}
              </caption>
              <thead>
                <tr className="text-[12px] text-muted">
                  <th className="px-5 py-2 text-left font-normal">{t('money.import.month')}</th>
                  <th className="px-2 py-2 text-right font-normal">{t('money.import.sheet')}</th>
                  <th className="px-2 py-2 text-right font-normal">{t('money.import.skippedCol')}</th>
                  <th className="px-5 py-2 text-right font-normal">{t(recon ? 'money.import.inGedara' : 'money.import.toImport')}</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {(recon?.months ?? months.map((m) => ({ month: m.month, sheet: sumAmounts([m.imported, m.skipped]), skipped: m.skipped, gedara: m.imported }))).map(
                  (m) => {
                    const ok = sumAmounts([m.gedara, m.skipped]) === m.sheet;
                    return (
                      <tr key={m.month} className="border-t border-line">
                        <td className="px-5 py-2">{formatMonth(m.month, locale)}</td>
                        <td className="px-2 py-2 text-right">{formatAmount(m.sheet)}</td>
                        <td className="px-2 py-2 text-right text-muted">{m.skipped ? formatAmount(m.skipped) : '—'}</td>
                        <td className={cn('px-5 py-2 text-right', recon && (ok ? 'text-teal' : 'text-red'))}>{formatAmount(m.gedara)}</td>
                      </tr>
                    );
                  },
                )}
              </tbody>
              <tfoot className="tabular">
                <tr className="border-t border-line-2 font-semibold">
                  <td className="px-5 py-2.5">{t('money.import.total')}</td>
                  <td className="px-2 py-2.5 text-right">{formatAmount(parsed.sheetTotal)}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{formatAmount(sumAmounts(parsed.skipped.map((s) => s.amount)))}</td>
                  <td className="px-5 py-2.5 text-right">
                    {formatAmount(sumAmounts((recon?.months ?? months.map((m) => ({ gedara: m.imported }))).map((m) => m.gedara)))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>

          {recon && (
            <Card className={cn('flex items-start gap-3', reconOk ? 'border-teal/40' : 'border-red/40')} role="status">
              {reconOk ? (
                <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red" aria-hidden />
              )}
              <p className="text-[14.5px]">
                {reconOk
                  ? t('money.import.reconOk', { lines: recon.linesFound })
                  : t('money.import.reconBad', { found: recon.linesFound, expected: recon.linesExpected })}
                {result && ` ${t('money.import.done', { count: result.imported, skipped: result.duplicate })}`}
              </p>
            </Card>
          )}

          {!recon && (
            <Button variant="primary" disabled={Boolean(progress)} onClick={() => void doImport()}>
              {progress
                ? t('money.import.progress', { done: progress.done, total: progress.total })
                : t('money.import.importSheet', { count: parsed.bills.length })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
