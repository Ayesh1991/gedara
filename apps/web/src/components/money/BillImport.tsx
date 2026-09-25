import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, CircleAlert, FileJson } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BillRouter, effectiveRoute, previewFor } from '@/components/spine/BillRouter';
import { categoryDestiny, useProposals, useSpineData, type RouterLine } from '@/components/spine/useSpine';
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
  deleteTransaction,
  existingFingerprints,
  importBills,
  invalidateMoney,
  moneyErrorKey,
  pickableAccounts,
  rememberAccount,
  type Account,
} from '@/lib/money/queries';
import { invalidatePantry } from '@/lib/pantry/queries';
import { invalidateShopping, shoppingListQuery } from '@/lib/spine/queries';
import { isBlocking, isUnresolved, routeProblem, toRpcRoute, unitByText, type LineRoute } from '@/lib/spine/route';
import { billSummary, type BillSummary } from '@/lib/spine/summary';
import { formatDay } from '@/lib/time';
import { thingsKey } from '@/lib/things/queries';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { AccountSelect, fieldLabel } from './bits';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Draft {
  bill: ImportBill;
  scanned: ScannedBill;
  duplicate: boolean;
}

/**
 * Bill-scanner JSON → preview (account per bill; per line: category and where it goes — pantry,
 * Things or expense only) → one Import that logs the expense, creates the lots and ticks the list.
 */
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
  const spine = useSpineData(householdId);
  const list = useQuery(shoppingListQuery(householdId));
  const [text, setTextRaw] = useState('');
  const [fileError, setFileError] = useState<{ kind: 'type' | 'size' } | null>(null);
  // Per-bill edits (account, categories), valid only for the text they were made on.
  const [edited, setEdited] = useState<{ text: string; bills: ImportBill[] } | null>(null);
  const [existing, setExisting] = useState<{ text: string; fps: Set<string> } | null>(null);
  // Per-line route changes and picked free-text list items, also per text.
  const [overrides, setOverrides] = useState<{ text: string; routes: Record<string, LineRoute> }>({ text: '', routes: {} });
  const [ticks, setTicks] = useState<{ text: string; byBill: Record<number, string[]> }>({ text: '', byBill: {} });
  const [created, setCreated] = useState<Set<string>>(new Set());
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
  const drafts: Draft[] | null = useMemo(() => {
    const bills = edited?.text === text ? edited.bills : built?.map((d) => d.bill);
    return built && bills && existing?.text === text
      ? built.map((d, i) => ({ scanned: d.scanned, bill: bills[i]!, duplicate: existing.fps.has(d.bill.fingerprint) }))
      : null;
  }, [built, edited, existing, text]);

  // Lines as the router sees them (only bills that will be imported).
  const units = spine.units.data;
  const routerLines = useMemo(
    () =>
      (drafts ?? []).map((d, i) =>
        d.duplicate || !units
          ? []
          : d.bill.lines.map(
              (l): RouterLine => ({
                key: `${i}:${l.fingerprint}`,
                raw_name: l.raw_name,
                amount: l.amount,
                qty: l.qty,
                unitId: unitByText(units, l.unit_text),
                unitMissing: Boolean(l.unitMissing),
                synthetic: l.synthetic,
                category_id: l.category_id,
                barcode: l.barcode,
              }),
            ),
      ),
    [drafts, units],
  );
  const allLines = useMemo(() => routerLines.flat(), [routerLines]);
  const proposals = useProposals(allLines, spine);
  const routeOf = (l: RouterLine): LineRoute | undefined => {
    const r = (overrides.text === text ? overrides.routes[l.key] : undefined) ?? proposals.get(l.key);
    return r ? effectiveRoute(r, l, spine.products.data) : undefined;
  };
  const openItems = useMemo(() => (list.data ?? []).filter((i) => !i.done && !i.dismissed), [list.data]);
  const openFree = openItems.filter((i) => !i.product_id);
  const ticksFor = (i: number) => (ticks.text === text ? (ticks.byBill[i] ?? []) : []);

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

  function setRoute(key: string, route: LineRoute) {
    setOverrides((o) => ({ text, routes: { ...(o.text === text ? o.routes : {}), [key]: route } }));
  }

  function toggleTick(i: number, id: string) {
    setTicks((tk) => {
      const byBill = tk.text === text ? tk.byBill : {};
      const cur = byBill[i] ?? [];
      return { text, byBill: { ...byBill, [i]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } };
    });
  }

  const toImport = drafts?.map((d, i) => ({ d, i })).filter(({ d }) => !d.duplicate) ?? [];
  const summaries = new Map<number, BillSummary>();
  const unresolved = new Map<number, number>();
  let problems = 0;
  for (const { i } of toImport) {
    const lines = routerLines[i] ?? [];
    const routes = lines.map(routeOf).filter((r): r is LineRoute => Boolean(r));
    unresolved.set(i, routes.filter(isUnresolved).length);
    summaries.set(i, billSummary(routes.filter((r) => !isUnresolved(r)), openItems, ticksFor(i), created));
    for (const l of lines) {
      const r = routeOf(l);
      if (r && isBlocking(routeProblem(r, previewFor(r, l, spine)))) problems++;
    }
  }
  const total = [...summaries.values()].reduce(
    (a, s) => ({ stock: a.stock + s.stock, newProducts: a.newProducts + s.newProducts, ticked: a.ticked + s.ticked }),
    { stock: 0, newProducts: 0, ticked: 0 },
  );

  async function doImport() {
    if (!toImport.length || busy || !spine.ready) return;
    if (toImport.some(({ d }) => d.bill.lines.some((l) => !l.category_id))) {
      toast.error(t('money.form.needCategory'));
      return;
    }
    if (problems > 0) {
      toast.error(t('spine.fix', { count: problems }));
      return;
    }
    setBusy(true);
    try {
      const payload = toImport.map(({ d, i }) => {
        const lines = routerLines[i] ?? [];
        return {
          ...d.bill,
          tick_item_ids: ticksFor(i),
          lines: d.bill.lines.map((l, j) => {
            const rl = lines[j];
            const r = rl ? routeOf(rl) : undefined;
            // Unresolved pantry lines go in as plain lines ("Send to pantry" later).
            return r && !isUnresolved(r) ? { ...l, route: toRpcRoute(r, categoryDestiny(categories, l.category_id), l.synthetic) } : l;
          }),
        };
      });
      const results = await importBills(householdId, payload);
      for (const { d } of toImport) {
        if (d.bill.account_id !== suspense?.id) rememberAccount(d.bill.account_id, d.bill.payee_text);
      }
      const imported = results.filter((r) => r.status === 'imported');
      const lots = imported.reduce((a, r) => a + (r.lots ?? 0), 0);
      const ticked = imported.reduce((a, r) => a + (r.ticked ?? 0), 0);
      // Things lines wait in "Bought, not entered yet" until their details are added.
      const importedFps = new Set(imported.map((r) => r.fingerprint));
      const toEnter = payload
        .filter((b) => importedFps.has(b.fingerprint))
        .reduce((a, b) => a + b.lines.filter((l) => (l as { route?: { destiny?: string } }).route?.destiny === 'asset').length, 0);
      await Promise.all([
        invalidateMoney(qc, householdId),
        invalidatePantry(qc, householdId),
        invalidateShopping(qc, householdId),
        qc.invalidateQueries({ queryKey: thingsKey(householdId) }),
      ]);
      const ids = imported.map((r) => r.id).filter((x): x is string => Boolean(x));
      toast.success(
        [
          t('money.import.done', { count: imported.length, skipped: results.length - imported.length }),
          lots ? t('spine.lotsAdded', { count: lots }) : null,
          ticked ? t('spine.ticked', { count: ticked }) : null,
          toEnter ? t('things.toEnter', { count: toEnter }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        {
          duration: UNDO_MS,
          action: ids.length
            ? {
                label: t('common.undo'),
                onClick: () => {
                  // Undo = delete the bills again (their untouched stock goes with them).
                  Promise.all(ids.map((id) => deleteTransaction(id)))
                    .then(() => toast(t('spine.importUndone')))
                    .catch((e: unknown) => toast.error(t(`money.errors.${moneyErrorKey(e)}`)))
                    .finally(() => {
                      void invalidateMoney(qc, householdId);
                      void invalidatePantry(qc, householdId);
                      void invalidateShopping(qc, householdId);
                    });
                },
              }
            : undefined,
        },
      );
      if (ids.length === 1) {
        void navigate({ to: '/money/tx/$txId', params: { txId: ids[0]! } });
      } else {
        void navigate({ to: '/money', search: { month: toImport[0]!.d.bill.occurred_on.slice(0, 7) } });
      }
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

      {drafts?.map((d, i) => {
        const s = summaries.get(i);
        const routes = new Map<string, LineRoute>();
        for (const l of routerLines[i] ?? []) {
          const r = routeOf(l);
          if (r) routes.set(l.key, r);
        }
        return (
          <Card key={d.bill.fingerprint + i} className={cn('flex flex-col gap-3', d.duplicate && 'opacity-60')} data-testid="import-bill">
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
                {spine.ready ? (
                  <BillRouter
                    lines={routerLines[i] ?? []}
                    routes={routes}
                    data={spine}
                    onRoute={setRoute}
                    onCreated={(id) => setCreated((c) => new Set(c).add(id))}
                    onCategory={(key, id) => {
                      const j = (routerLines[i] ?? []).findIndex((l) => l.key === key);
                      update(i, (x) => ({
                        ...x,
                        bill: { ...x.bill, lines: x.bill.lines.map((y, k) => (k === j ? { ...y, category_id: id, guessed: false } : y)) },
                      }));
                    }}
                  />
                ) : (
                  <div className="glass h-32 animate-pulse rounded-2xl" aria-hidden />
                )}
                {d.bill.lines.some((l) => l.synthetic) && (
                  <p className="text-[12.5px] text-muted">
                    {t('money.import.adjusted', {
                      lines: formatLKR(sumAmounts(d.bill.lines.filter((l) => !l.synthetic).map((l) => l.amount))),
                    })}
                  </p>
                )}
                {openFree.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className={fieldLabel}>{t('spine.alsoBought')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {openFree.map((it) => {
                        const on = ticksFor(i).includes(it.id!);
                        return (
                          <button
                            key={it.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleTick(i, it.id!)}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px]',
                              on ? 'border-transparent bg-teal/15 text-teal' : 'border-line-2 text-[#c5cce3]',
                            )}
                          >
                            {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                            {it.free_text}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {s && (
                  <p className="tabular text-[13px] text-muted" data-testid="bill-summary">
                    {t('spine.billSummary', { stock: s.stock, ticked: s.ticked })}
                    {s.newProducts > 0 && ` · ${t('spine.newProducts', { count: s.newProducts })}`}
                  </p>
                )}
                {(unresolved.get(i) ?? 0) > 0 && (
                  <p className="text-[12.5px] text-caution">{t('spine.unresolved', { count: unresolved.get(i) })}</p>
                )}
              </>
            )}
          </Card>
        );
      })}

      {drafts && (
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            disabled={busy || toImport.length === 0 || !spine.ready || problems > 0}
            onClick={() => void doImport()}
          >
            {toImport.length === 0
              ? t('money.import.nothingNew')
              : problems > 0
                ? t('spine.fix', { count: problems })
                : t('money.import.importBills', {
                    count: toImport.length,
                    total: formatLKR(sumAmounts(toImport.map(({ d }) => d.bill.total))),
                  })}
          </Button>
          {toImport.length > 0 && problems === 0 && (total.stock > 0 || total.ticked > 0) && (
            <p className="text-center text-[12.5px] text-muted">{t('spine.oneConfirm', { stock: total.stock, ticked: total.ticked })}</p>
          )}
        </div>
      )}
    </div>
  );
}
