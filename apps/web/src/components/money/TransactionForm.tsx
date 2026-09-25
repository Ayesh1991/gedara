import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { lineFingerprint, manualFingerprint } from '@/lib/money/fingerprint';
import { formatLKR, parseAmount, sumAmounts } from '@/lib/money/format';
import { findSub, type CategoryRow } from '@/lib/money/categoriesMap';
import {
  invalidateMoney,
  lastAccount,
  moneyErrorKey,
  pickableAccounts,
  rememberAccount,
  saveTransaction,
  type Account,
  type SaveLine,
  type SavePayload,
  type Transaction,
} from '@/lib/money/queries';
import { timeNowIn, todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AccountSelect, CategorySelect, Money, fieldLabel } from './bits';

type FormType = 'expense' | 'income' | 'transfer';

// ledger v7 QUICK tiles: one tap picks the category (label, top key, sub-category).
const QUICK: Array<[string, string, string, string]> = [
  ['⛽', 'Fuel', 'energy', 'Petrol'],
  ['⚡', 'Electricity', 'energy', 'Electricity'],
  ['🔥', 'LP Gas', 'energy', 'LP Gas'],
  ['💧', 'Water', 'water', 'Water bill'],
  ['🛡️', 'Insurance', 'services', 'Insurance'],
  ['📶', 'Telecom', 'services', 'Mobile & telephone'],
  ['🍽️', 'Dining', 'dining', 'Restaurant'],
  ['🛒', 'Grocery', 'grocery', 'Other grocery'],
];

interface LineState {
  key: string;
  name: string;
  categoryId: string | null;
  amount: string;
  /** Kept from the saved line when editing, so imported lines keep their identity. */
  fingerprint?: string;
  qty?: number | null;
  unit_text?: string | null;
  unit_price?: number | null;
}

export interface TransactionFormProps {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  accounts: Account[];
  categories: CategoryRow[];
  merchants: Array<{ id: string; name: string }>;
  initialType?: FormType;
  editing?: { tx: Transaction; fee: Transaction | null } | null;
  onSaved?: (id: string) => void;
}

export function TransactionForm(props: TransactionFormProps) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={t(props.editing ? 'money.form.editTitle' : 'money.form.addTitle')}
    >
      <FormBody {...props} />
    </Sheet>
  );
}

function FormBody({
  onClose,
  householdId,
  timezone,
  accounts,
  categories,
  merchants,
  initialType = 'expense',
  editing,
  onSaved,
}: TransactionFormProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tx = editing?.tx ?? null;
  const pickable = pickableAccounts(accounts, tx?.account_id);
  const defaultAccount =
    tx?.account_id ?? pickable.find((a) => a.id === lastAccount())?.id ?? pickable.find((a) => a.kind === 'cash')?.id ?? null;

  const [type, setType] = useState<FormType>((tx?.type as FormType | undefined) ?? initialType);
  const [amount, setAmount] = useState(tx ? String(tx.total) : '');
  const [accountId, setAccountId] = useState<string | null>(defaultAccount);
  const [toAccountId, setToAccountId] = useState<string | null>(tx?.to_account_id ?? null);
  const [date, setDate] = useState(tx?.occurred_on ?? todayIn(timezone));
  const [time, setTime] = useState(tx?.occurred_at?.slice(0, 5) ?? (tx ? '' : timeNowIn(timezone)));
  const [payee, setPayee] = useState(tx?.payee_text ?? '');
  const [invoiceNo, setInvoiceNo] = useState(tx?.invoice_no ?? '');
  const [notes, setNotes] = useState(tx?.notes ?? '');
  const [fee, setFee] = useState(editing?.fee ? String(editing.fee.total) : '');
  const [split, setSplit] = useState((tx?.lines.length ?? 0) > 1);
  const [lines, setLines] = useState<LineState[]>(() =>
    (tx?.lines ?? []).map((l) => ({
      key: l.id,
      name: l.raw_name,
      categoryId: l.category_id,
      amount: String(l.amount),
      fingerprint: l.fingerprint,
      qty: l.qty,
      unit_text: l.unit_text,
      unit_price: l.unit_price,
    })),
  );
  const [categoryId, setCategoryId] = useState<string | null>(tx?.lines[0]?.category_id ?? null);
  const [busy, setBusy] = useState(false);
  const [confirmDup, setConfirmDup] = useState(false);
  // A bill whose lines feed the pantry keeps its lines: only the header can change (GDRTD).
  const locked = Boolean(tx?.lines.some((l) => l.product_id));

  const kind = type === 'income' ? 'income' : 'expense';
  const linesTotal = sumAmounts(lines.map((l) => parseAmount(l.amount) ?? 0));
  const bankFees = useMemo(() => findSub(categories, 'services', 'Banking & fees'), [categories]);
  const quick = useMemo(
    () => QUICK.map(([icon, label, key, sub]) => ({ icon, label, cat: findSub(categories, key, sub) })).filter((q) => q.cat),
    [categories],
  );

  function switchType(next: FormType) {
    setType(next);
    setCategoryId(null);
    setLines([]);
    setSplit(false);
  }

  function startSplit() {
    const first: LineState = { key: crypto.randomUUID(), name: payee, categoryId, amount };
    setLines([first, { key: crypto.randomUUID(), name: '', categoryId, amount: '' }]);
    setSplit(true);
  }

  function buildPayload(repeat: number): SavePayload | null {
    const total = locked ? tx!.total : split ? linesTotal : parseAmount(amount);
    if (total === null || total <= 0) {
      toast.error(t('money.form.needAmount'));
      return null;
    }
    if (!accountId || (type === 'transfer' && !toAccountId)) {
      toast.error(t('money.form.needAccount'));
      return null;
    }
    const feeAmount = type === 'transfer' && fee.trim() ? parseAmount(fee) : null;
    if (type === 'transfer' && fee.trim() && (feeAmount === null || feeAmount < 0)) {
      toast.error(t('money.form.needAmount'));
      return null;
    }
    const occurredAt = time || null;
    const fp =
      tx?.fingerprint ??
      manualFingerprint({ type, date, time: occurredAt, accountId, payee, total }, repeat);

    let saveLines: SaveLine[] = [];
    if (type !== 'transfer' && !locked) {
      const source: LineState[] = split
        ? lines.filter((l) => l.name.trim() || parseAmount(l.amount))
        : [
            {
              key: 'single',
              name: '',
              categoryId,
              amount: String(total),
              fingerprint: tx?.lines.length === 1 ? tx.lines[0]!.fingerprint : undefined,
              qty: tx?.lines.length === 1 ? tx.lines[0]!.qty : null,
              unit_text: tx?.lines.length === 1 ? tx.lines[0]!.unit_text : null,
              unit_price: tx?.lines.length === 1 ? tx.lines[0]!.unit_price : null,
            },
          ];
      if (source.some((l) => !l.categoryId)) {
        toast.error(t('money.form.needCategory'));
        return null;
      }
      const used = new Set<string>();
      saveLines = source.map((l, idx) => {
        const lineAmount = parseAmount(l.amount) ?? 0;
        const catName = categories.find((c) => c.id === l.categoryId)?.name;
        const name = l.name.trim() || (split ? '' : tx?.lines[0]?.raw_name) || catName || payee.trim() || t(`money.types.${type}`);
        let lfp = l.fingerprint ?? lineFingerprint(fp, idx, name, lineAmount);
        while (used.has(lfp)) lfp += 'x';
        used.add(lfp);
        return {
          raw_name: name,
          category_id: l.categoryId,
          qty: l.qty ?? null,
          unit_text: l.unit_text ?? null,
          unit_price: l.unit_price ?? null,
          amount: lineAmount,
          fingerprint: lfp,
        };
      });
    }

    return {
      id: tx?.id,
      household_id: householdId,
      type: tx?.type === 'refund' ? 'refund' : type,
      account_id: accountId,
      to_account_id: type === 'transfer' ? toAccountId : null,
      payee_text: type === 'transfer' ? null : payee.trim() || null,
      occurred_on: date,
      occurred_at: occurredAt,
      invoice_no: invoiceNo.trim() || null,
      notes: notes.trim() || null,
      total,
      fingerprint: fp,
      lines: saveLines,
      keep_lines: locked || undefined,
      fee: feeAmount ? { amount: feeAmount, category_id: bankFees?.id ?? null } : null,
    };
  }

  async function save(startRepeat: number) {
    setBusy(true);
    try {
      for (let repeat = startRepeat; repeat < 50; repeat++) {
        const payload = buildPayload(repeat);
        if (!payload) return;
        try {
          const saved = await saveTransaction(payload);
          rememberAccount(payload.account_id, payload.payee_text);
          await invalidateMoney(qc, householdId);
          toast.success(t(tx ? 'money.form.saved' : 'money.form.created', { amount: formatLKR(payload.total) }));
          onSaved?.(saved.id);
          onClose();
          return;
        } catch (err) {
          if (moneyErrorKey(err) === 'duplicate' && !tx) {
            if (repeat === 1) {
              setConfirmDup(true); // "Already saved — save another?"
              return;
            }
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!busy) void save(1);
  }

  const payeeListId = 'money-payees';

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {!tx && (
        <div role="tablist" aria-label={t('money.form.typeLabel')} className="grid grid-cols-3 gap-1 rounded-2xl bg-white/5 p-1">
          {(['expense', 'income', 'transfer'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={type === k}
              onClick={() => switchType(k)}
              className={cn(
                'h-10 rounded-xl font-display text-[14.5px] font-medium text-muted transition-colors',
                type === k && 'accent-pill text-text',
              )}
            >
              {t(`money.types.${k}`)}
            </button>
          ))}
        </div>
      )}

      {locked && (
        <div className="flex flex-col gap-1 rounded-2xl border border-line-2 bg-white/[0.03] p-4">
          <Money value={-tx!.total} className="text-[24px] font-semibold" />
          <p className="text-[13px] text-muted">{t('spine.lockedLines')}</p>
        </div>
      )}

      {!split && !locked && (
        <div>
          <label htmlFor="money-amount" className={fieldLabel}>
            {t('money.form.amount')}
          </label>
          <div className="relative">
            <span className="tabular pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[18px] text-muted">Rs</span>
            <Input
              id="money-amount"
              autoFocus={!tx}
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular h-16 pl-12 text-[28px]"
            />
          </div>
        </div>
      )}

      {type !== 'transfer' && !split && !locked && (
        <div>
          {type === 'expense' && !tx && quick.length > 0 && (
            <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1" aria-label={t('money.form.quick')}>
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setCategoryId(q.cat!.id)}
                  aria-pressed={categoryId === q.cat!.id}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full border border-line-2 bg-white/5 px-3 py-2 text-[13.5px]',
                    categoryId === q.cat!.id && 'accent-pill border-transparent',
                  )}
                >
                  <span aria-hidden>{q.icon}</span>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <label htmlFor="money-category" className={fieldLabel}>
            {t('money.form.category')}
          </label>
          <CategorySelect
            id="money-category"
            required
            kind={kind}
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
          />
        </div>
      )}

      <div className={cn('grid gap-4', type === 'transfer' && 'grid-cols-2')}>
        <div>
          <label htmlFor="money-account" className={fieldLabel}>
            {t(type === 'transfer' ? 'money.form.from' : type === 'income' ? 'money.form.into' : 'money.form.paidWith')}
          </label>
          <AccountSelect id="money-account" accounts={pickable} value={accountId} onChange={setAccountId} />
        </div>
        {type === 'transfer' && (
          <div>
            <label htmlFor="money-to" className={fieldLabel}>
              {t('money.form.to')}
            </label>
            <AccountSelect
              id="money-to"
              accounts={pickableAccounts(accounts, tx?.to_account_id)}
              value={toAccountId}
              onChange={setToAccountId}
              exclude={accountId}
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <div>
          <label htmlFor="money-date" className={fieldLabel}>
            {t('money.form.date')}
          </label>
          <Input id="money-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="money-time" className={fieldLabel}>
            {t('money.form.time')}
          </label>
          <Input id="money-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>

      {type === 'transfer' ? (
        <div>
          <label htmlFor="money-fee" className={fieldLabel}>
            {t('money.form.fee')}
          </label>
          <Input
            id="money-fee"
            inputMode="decimal"
            placeholder={t('money.form.feeHint')}
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            className="tabular"
          />
        </div>
      ) : (
        <div>
          <label htmlFor="money-payee" className={fieldLabel}>
            {t(type === 'income' ? 'money.form.payer' : 'money.form.payee')}
          </label>
          <Input
            id="money-payee"
            list={payeeListId}
            maxLength={120}
            autoComplete="off"
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
          />
          <datalist id={payeeListId}>
            {merchants.map((m) => (
              <option key={m.id} value={m.name} />
            ))}
          </datalist>
        </div>
      )}

      {split && !locked && (
        <fieldset className="flex flex-col gap-3 rounded-2xl border border-line-2 p-3">
          <legend className="px-1 text-[13px] font-medium text-muted">{t('money.form.lines')}</legend>
          {lines.map((l, i) => (
            <div key={l.key} className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-2.5">
              <div className="flex gap-2">
                <Input
                  aria-label={t('money.form.lineName')}
                  placeholder={t('money.form.lineName')}
                  value={l.name}
                  maxLength={200}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <Input
                  aria-label={t('money.form.amount')}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="tabular w-32 shrink-0"
                  value={l.amount}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
              </div>
              <div className="flex gap-2">
                <CategorySelect
                  kind={kind}
                  required
                  categories={categories}
                  value={l.categoryId}
                  onChange={(id) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, categoryId: id } : x)))}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('money.form.removeLine')}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  disabled={lines.length <= 1}
                >
                  <Trash className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <Button
              size="sm"
              onClick={() =>
                setLines((ls) => [...ls, { key: crypto.randomUUID(), name: '', categoryId: ls.at(-1)?.categoryId ?? null, amount: '' }])
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('money.form.addLine')}
            </Button>
            <span className="tabular text-[15px]">{formatLKR(linesTotal)}</span>
          </div>
        </fieldset>
      )}

      <details className="group rounded-2xl border border-line-2 px-4 py-3" open={Boolean(tx?.invoice_no || tx?.notes)}>
        <summary className="cursor-pointer text-[14px] font-medium text-muted">{t('money.form.more')}</summary>
        <div className="mt-3 flex flex-col gap-3">
          {type !== 'transfer' && !split && !locked && (
            <Button size="sm" className="self-start" onClick={startSplit}>
              {t('money.form.split')}
            </Button>
          )}
          <div>
            <label htmlFor="money-invoice" className={fieldLabel}>
              {t('money.form.invoice')}
            </label>
            <Input id="money-invoice" maxLength={60} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </div>
          <div>
            <label htmlFor="money-notes" className={fieldLabel}>
              {t('money.form.notes')}
            </label>
            <textarea
              id="money-notes"
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-[14px] border border-line-2 bg-white/5 px-4 py-3 text-[16px] text-text focus:border-accent-a focus:outline-none"
            />
          </div>
        </div>
      </details>

      {confirmDup ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-caution/40 bg-caution/10 p-4" role="alert">
          <p className="text-[14px]">{t('money.form.duplicate')}</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              {t('money.form.dontSave')}
            </Button>
            <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void save(2)}>
              {t('money.form.saveAnother')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? t('common.saving') : t(tx ? 'money.form.saveChanges' : 'money.form.save')}
        </Button>
      )}
    </form>
  );
}
