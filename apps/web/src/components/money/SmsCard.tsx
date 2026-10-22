import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftRight, CircleAlert, Info, Landmark, Link2, MessageSquareText, Plus, RotateCcw, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findSub, type CategoryRow } from '@/lib/money/categoriesMap';
import { lineFingerprint } from '@/lib/money/fingerprint';
import { formatDay } from '@/lib/time';
import { parseAmount } from '@/lib/money/format';
import { builtInCategory, learnSoon, merchantMemory, type Memory } from '@/lib/match/memory';
import { decide, type Suggestion as AiSuggestion } from '@/lib/match/queries';
import { createAccount, moneyErrorKey, type Account } from '@/lib/money/queries';
import type { Gap, Suggestion, TxCandidate } from '@/lib/sms/match';
import { smsSigned } from '@/lib/sms/match';
import { smsIgnore, smsLink, smsPost, type InboxRow } from '@/lib/sms/queries';
import { cn } from '@/lib/utils';
import { AccountDot, AccountSelect, CategorySelect, Money, fieldLabel } from './bits';

export interface CardItem {
  rows: InboxRow[]; // 1, or 2 for a transfer pair (debit + payment)
  suggestion: Suggestion;
  gap: Gap | null;
  lkr: { amount: number | null; estimated: boolean };
}

/** What a confident suggestion does in one tap ("Accept all"). null = needs a person. */
export async function applyConfident(
  item: CardItem,
  ctx: { householdId: string; categories: CategoryRow[] },
): Promise<boolean> {
  const s = item.suggestion;
  const ids = item.rows.map((r) => r.id);
  if (s.kind === 'link' && s.confident) {
    await smsLink(ids, s.txId);
    return true;
  }
  if (s.kind === 'transfer' && s.confident) {
    await smsPost(ids, transferPayload(item, s, ctx.householdId, ctx.categories));
    return true;
  }
  if (s.kind === 'note' && s.confident) {
    // a note moves no money: "seen" is all it needs
    await smsIgnore(ids, true);
    return true;
  }
  return false;
}

function earliest(rows: InboxRow[]): InboxRow {
  return [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at))[0]!;
}

function transferPayload(item: CardItem, s: Extract<Suggestion, { kind: 'transfer' }>, householdId: string, categories: CategoryRow[]) {
  const first = earliest(item.rows);
  const fee = findSub(categories, 'services', 'Banking & fees');
  return {
    household_id: householdId,
    type: 'transfer' as const,
    account_id: s.from,
    to_account_id: s.to,
    occurred_on: first.occurred_on,
    occurred_at: first.occurred_at,
    total: s.total,
    lines: [],
    fee: s.fee > 0 ? { amount: s.fee, category_id: fee?.id ?? null } : null,
  };
}

export function SmsCard({
  item,
  householdId,
  locale,
  today,
  accounts,
  categories,
  candidates,
  memory,
  ai,
  canWrite,
  onDone,
}: {
  item: CardItem;
  householdId: string;
  locale: string;
  today: string;
  accounts: Account[];
  categories: CategoryRow[];
  candidates: TxCandidate[];
  memory: Memory | undefined;
  /** Phase 9b: what the matcher suggests for this alert (a category, or a bill with a close total). */
  ai?: { category?: AiSuggestion; link?: AiSuggestion };
  canWrite: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const row = item.rows[0]!;
  const s = item.suggestion;
  const account = accounts.find((a) => a.id === row.account_id);
  const byId = (id: string | null) => accounts.find((a) => a.id === id);
  const incoming = row.kind === 'bank_credit' || row.kind === 'card_payment' || row.kind === 'refund';
  // What the category / account is remembered by: the merchant, or what the matcher says it is ("ETC top-up").
  const memoText = s.kind === 'expense' ? s.memo : row.merchant_text;
  const remembered = merchantMemory(memory, memoText);
  const [mode, setMode] = useState<'suggested' | 'new' | 'pick'>(s.kind === 'none' ? 'new' : 'suggested');
  const [busy, setBusy] = useState(false);
  const aiCategory = ai?.category?.proposal.category_id ?? null;
  const [categoryId, setCategoryId] = useState<string | null>(
    () => remembered?.category_id ?? builtInCategory(categories, memoText) ?? aiCategory,
  );
  const usedAi = !remembered?.category_id && !builtInCategory(categories, memoText) && !!aiCategory;
  /** Tell the matcher what the person did with its suggestion (never blocks the save). */
  const tell = (sug: AiSuggestion | undefined, chosen: string | null, key: 'category_id' | 'transaction_id') => {
    if (!sug) return;
    const proposed = sug.proposal[key] ?? null;
    void decide([sug.id], chosen === proposed ? 'accepted' : chosen ? 'changed' : 'rejected', chosen ? { [key]: chosen } : undefined)
      .catch(() => undefined);
  };
  const [amount, setAmount] = useState(item.lkr.amount !== null ? String(item.lkr.amount) : '');
  const [newAccount, setNewAccount] = useState<string | null>(
    row.account_id ?? (s.kind === 'expense' ? s.account : null) ?? remembered?.account_id ?? null,
  );
  const [pick, setPick] = useState<string | null>(s.kind === 'link' ? s.txId : null);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onDone();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const linkTo = (txId: string) =>
    run(async () => {
      const r = await smsLink(item.rows.map((x) => x.id), txId);
      tell(ai?.link, txId, 'transaction_id');
      if (r.moved) toast.message(t('money.inbox.movedTo', { name: account?.name ?? '' }));
    }, t('money.inbox.linked'));

  const saveNew = (type: 'expense' | 'income' | 'refund') => {
    const total = parseAmount(amount);
    if (total === null || total <= 0) return toast.error(t('money.inbox.needAmount'));
    if (!categoryId) return toast.error(t('money.inbox.needCategory'));
    if (!newAccount) return toast.error(t('money.form.needAccount'));
    const name = row.merchant_text || t(`money.inbox.kinds.${row.kind as 'card_charge'}`);
    // the household remembers the category (and, for an alert that names no account, the account)
    learnSoon(qc, householdId, [{ kind: 'merchant', text: memoText, category_id: categoryId, account_id: row.account_id ? null : newAccount }]);
    if (usedAi) tell(ai?.category, categoryId, 'category_id');
    tell(ai?.link, null, 'transaction_id');
    return run(
      () =>
        smsPost([row.id], {
          household_id: householdId,
          type,
          account_id: newAccount,
          payee_text: row.merchant_text,
          occurred_on: row.occurred_on,
          occurred_at: row.occurred_at,
          total,
          notes: row.currency !== 'LKR' ? `${row.currency} ${row.amount}` : null,
          lines: [{ raw_name: name, category_id: categoryId, amount: total, fingerprint: lineFingerprint(row.fingerprint, 0, name, total) }],
        }),
      t('money.inbox.saved'),
    );
  };

  const saveTransfer = (tr: Extract<Suggestion, { kind: 'transfer' }>) =>
    run(() => smsPost(item.rows.map((x) => x.id), transferPayload(item, tr, householdId, categories)), t('money.inbox.saved'));

  const ignore = () =>
    run(async () => {
      await smsIgnore(item.rows.map((x) => x.id), true);
      tell(ai?.category, null, 'category_id');
      tell(ai?.link, null, 'transaction_id');
    }, t('money.inbox.ignored'));
  const markSeen = () => run(() => smsIgnore(item.rows.map((x) => x.id), true), t('money.inbox.seen'));

  // A loan paid out: a transfer from the loan account (made here once, from the alert itself).
  const saveLoan = (loan: Extract<Suggestion, { kind: 'loan' }>, loanAccount: string) =>
    run(
      () =>
        smsPost([row.id], {
          household_id: householdId,
          type: 'transfer',
          account_id: loanAccount,
          to_account_id: loan.account,
          occurred_on: row.occurred_on,
          occurred_at: row.occurred_at,
          total: loan.total,
          lines: [],
          fee: null,
        }),
      t('money.inbox.saved'),
    );
  const addLoanAccount = (loan: Extract<Suggestion, { kind: 'loan' }>) =>
    run(
      () =>
        createAccount(householdId, {
          name: t('money.inbox.loanName', { bank: row.institution ?? '' }).trim(),
          kind: 'loan',
          institution: row.institution,
          last4: null,
          credit_limit: loan.total,
        }),
      t('money.inbox.loanAdded'),
    );

  // Same amount, ±7 days: what "Pick another" offers.
  const sameAmount = candidates
    .filter((c) => item.lkr.amount !== null && Math.round(c.total * 100) === Math.round(item.lkr.amount * 100))
    .filter((c) => Math.abs(Date.parse(c.occurred_on) - Date.parse(row.occurred_on)) <= 7 * 86_400_000)
    .slice(0, 8);
  const describe = (c: TxCandidate | undefined) =>
    c
      ? [
          c.type === 'transfer'
            ? t('money.list.transfer', { from: byId(c.account_id)?.name ?? '?', to: byId(c.to_account_id)?.name ?? '?' })
            : c.payee_text || t(`money.types.${c.type as 'expense'}`),
          formatDay(c.occurred_on, locale, today.slice(0, 4)),
          byId(c.account_id)?.is_suspense ? byId(c.account_id)?.name : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  const newType: 'expense' | 'income' | 'refund' = row.kind === 'refund' ? 'refund' : incoming ? 'income' : 'expense';
  const kindForNew: 'expense' | 'income' = newType === 'income' ? 'income' : 'expense';
  const saveLabel = { expense: 'money.inbox.saveExpense', income: 'money.inbox.saveIncome', refund: 'money.inbox.saveRefund' } as const;

  return (
    <li className="flex flex-col gap-3 px-3.5 py-3.5 sm:px-4">
      {/* The alert(s) */}
      <div className="flex items-start gap-3">
        {account ? <AccountDot account={account} /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-muted"><MessageSquareText className="h-[18px] w-[18px]" aria-hidden /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">
              {s.kind === 'transfer' && item.rows.length === 2
                ? t('money.list.transfer', { from: byId(s.from)?.name ?? '?', to: byId(s.to)?.name ?? '?' })
                : row.merchant_text || t(`money.inbox.kinds.${row.kind as 'card_charge'}`)}
            </span>
          </div>
          <div className="truncate text-[12.5px] text-muted">
            {[
              row.occurred_at?.slice(0, 5),
              t(`money.inbox.kinds.${row.kind as 'card_charge'}`),
              account ? account.name : row.last_digits ? t('money.inbox.unknownAccount', { digits: row.last_digits }) : row.sender,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="text-right">
          {row.amount !== null && row.currency !== 'LKR' ? (
            <>
              <span className="tabular block text-[14px]">{`${incoming ? '+' : '−'}${row.currency} ${row.amount.toFixed(2)}`}</span>
              {item.lkr.amount !== null && <Money value={smsSigned(row, item.lkr.amount)} className="text-[12px] text-muted" />}
            </>
          ) : row.amount !== null ? (
            <Money value={smsSigned(row, row.amount)} tone plus className="text-[14px] sm:text-[15px]" />
          ) : null}
        </div>
      </div>

      {item.gap && (
        <p className="flex items-start gap-2 rounded-xl bg-caution/10 px-3 py-2 text-[13px] text-caution">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t('money.inbox.gap', { expected: item.gap.expected.toFixed(2), reported: item.gap.reported.toFixed(2) })}{' '}
            {/* Phase 7c: a missed alert can come back from a backup file or a screenshot. */}
            <Link to="/money/import" search={{ tab: 'sms' }} className="font-medium underline underline-offset-2">
              {t('money.inbox.addMissed')}
            </Link>
          </span>
        </p>
      )}

      {/* What it probably is */}
      {canWrite && mode === 'suggested' && s.kind !== 'none' && (
        <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.035] p-3">
          {s.kind === 'link' && (
            <>
              <p className="flex items-start gap-2 text-[13.5px]">
                <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden />
                <span>
                  {t('money.inbox.matches', { what: describe(candidates.find((c) => c.id === s.txId)) })}
                  {s.moves && <span className="block text-[12.5px] text-muted">{t('money.inbox.willMove', { name: account?.name ?? '' })}</span>}
                  {!s.confident && <span className="block text-[12.5px] text-caution">{t('money.inbox.checkIt')}</span>}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" disabled={busy} onClick={() => void linkTo(s.txId)}>
                  {t('money.inbox.link')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode('pick')}>{t('money.inbox.pickOther')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setMode('new')}>{t('money.inbox.createNew')}</Button>
              </div>
            </>
          )}
          {s.kind === 'transfer' && (
            <>
              <p className="flex items-start gap-2 text-[13.5px]">
                <ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-due" aria-hidden />
                <span>
                  {t('money.inbox.transfer', { from: byId(s.from)?.name ?? '?', to: byId(s.to)?.name ?? '?' })}
                  {s.fee > 0 && <span className="block text-[12.5px] text-muted">{t('money.inbox.withFee', { fee: s.fee.toFixed(2) })}</span>}
                  {!s.confident && <span className="block text-[12.5px] text-caution">{t('money.inbox.checkFrom')}</span>}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" disabled={busy} onClick={() => void saveTransfer(s)}>
                  {t('money.inbox.saveTransfer')}
                </Button>
                {item.rows.length === 1 && (
                  <Button size="sm" variant="ghost" onClick={() => setMode('new')}>{t('money.inbox.createNew')}</Button>
                )}
                {sameAmount.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setMode('pick')}>{t('money.inbox.pickOther')}</Button>
                )}
              </div>
            </>
          )}
          {(s.kind === 'expense' || s.kind === 'income') && (
            <p className="flex items-center gap-2 text-[13.5px] text-muted">
              <Plus className="h-4 w-4 shrink-0" aria-hidden />
              {t(s.kind === 'income' ? 'money.inbox.newIncome' : 'money.inbox.newExpense')}
            </p>
          )}
          {ai?.link && s.kind === 'expense' && ai.link.proposal.transaction_id && (
            <>
              <p className="flex items-start gap-2 text-[13.5px]">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
                <span>
                  {t('match.sameAs', { what: describe(candidates.find((c) => c.id === ai.link!.proposal.transaction_id)) || '…' })}
                  <span className="block text-[12.5px] text-muted">
                    {t('match.closeTotal', { pct: Math.round(ai.link.confidence * 100) })}
                  </span>
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void linkTo(ai.link!.proposal.transaction_id!)}>
                  {t('money.inbox.link')}
                </Button>
              </div>
            </>
          )}
          {s.kind === 'refund' && (
            <p className="flex items-start gap-2 text-[13.5px]">
              <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden />
              <span>
                {t('money.inbox.refund')}
                <span className={cn('block text-[12.5px]', s.confident ? 'text-muted' : 'text-caution')}>
                  {t(s.chargeSmsId ? 'money.inbox.refundFound' : 'money.inbox.refundNoCharge')}
                </span>
              </span>
            </p>
          )}
          {s.kind === 'note' && (
            <>
              <p className="flex items-start gap-2 text-[13.5px]">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
                <span>{t(`money.inbox.note.${s.reason}`)}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" disabled={busy} onClick={() => void markSeen()}>
                  {t('money.inbox.markSeen')}
                </Button>
              </div>
            </>
          )}
          {s.kind === 'loan' && (
            <>
              <p className="flex items-start gap-2 text-[13.5px]">
                <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-due" aria-hidden />
                <span>
                  {s.loanAccount
                    ? t('money.inbox.transfer', { from: byId(s.loanAccount)?.name ?? '?', to: byId(s.account)?.name ?? '?' })
                    : t('money.inbox.loanLooks')}
                  <span className="block text-[12.5px] text-muted">{t('money.inbox.loanNotIncome')}</span>
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                {s.loanAccount ? (
                  <Button size="sm" variant="accent" disabled={busy} onClick={() => void saveLoan(s, s.loanAccount!)}>
                    {t('money.inbox.saveTransfer')}
                  </Button>
                ) : (
                  <Button size="sm" variant="accent" disabled={busy} onClick={() => void addLoanAccount(s)}>
                    {t('money.inbox.addLoan')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setMode('new')}>{t('money.inbox.createNew')}</Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Create a new expense / income from the alert */}
      {canWrite && item.rows.length === 1 && (mode === 'new' || (mode === 'suggested' && (s.kind === 'expense' || s.kind === 'income' || s.kind === 'refund'))) && (
        <div className="flex flex-col gap-2.5 rounded-2xl bg-white/[0.035] p-3">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={fieldLabel} htmlFor={`sms-amt-${row.id}`}>
                {t('money.inbox.amountLkr')}
              </label>
              <Input
                id={`sms-amt-${row.id}`}
                inputMode="decimal"
                className="tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor={`sms-acct-${row.id}`}>
                {t('money.filters.account')}
              </label>
              <AccountSelect
                id={`sms-acct-${row.id}`}
                accounts={accounts.filter((a) => !a.archived && !a.is_suspense)}
                value={newAccount}
                onChange={setNewAccount}
              />
            </div>
          </div>
          {item.lkr.estimated && <p className="text-[12.5px] text-muted">{t('money.inbox.fxEstimated')}</p>}
          {usedAi && ai?.category && (
            <p className="flex items-center gap-1.5 text-[12.5px] text-info">
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('match.categoryHint', { pct: Math.round(ai.category.confidence * 100) })}
            </p>
          )}
          <div>
            <label className={fieldLabel} htmlFor={`sms-cat-${row.id}`}>
              {t('money.filters.category')}
            </label>
            <CategorySelect id={`sms-cat-${row.id}`} categories={categories} value={categoryId} onChange={setCategoryId} kind={kindForNew} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="accent" disabled={busy} onClick={() => void saveNew(newType)}>
              {t(saveLabel[newType])}
            </Button>
            {s.kind !== 'none' && mode === 'new' && (
              <Button size="sm" variant="ghost" onClick={() => setMode('suggested')}>{t('money.inbox.back')}</Button>
            )}
          </div>
        </div>
      )}

      {/* Link to another existing transaction */}
      {canWrite && mode === 'pick' && (
        <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.035] p-3">
          {sameAmount.length === 0 ? (
            <p className="text-[13px] text-muted">{t('money.inbox.nothingSameAmount')}</p>
          ) : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className={fieldLabel}>{t('money.inbox.sameAmount')}</legend>
              {sameAmount.map((c) => (
                <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13.5px]">
                  <input
                    type="radio"
                    name={`sms-pick-${row.id}`}
                    className="h-4 w-4 accent-[var(--accent-a)]"
                    checked={pick === c.id}
                    onChange={() => setPick(c.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{describe(c)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="accent" disabled={busy || !pick} onClick={() => pick && void linkTo(pick)}>
              {t('money.inbox.link')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(s.kind === 'none' ? 'new' : 'suggested')}>
              {t('money.inbox.back')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <details className="min-w-0 flex-1 text-[12.5px] text-muted">
          <summary className="cursor-pointer select-none">
            {t(item.rows.length > 1 ? 'money.inbox.showMessages' : 'money.inbox.showMessage')}
          </summary>
          {item.rows.map((r) => (
            <p key={r.id} className="mt-1.5 rounded-xl bg-black/20 px-3 py-2 break-words whitespace-pre-wrap">
              <span className="font-mono text-faint">{r.sender}: </span>
              {r.body}
            </p>
          ))}
        </details>
        {canWrite && (
          <div className="flex shrink-0 gap-1">
            {mode === 'suggested' && s.kind !== 'link' && s.kind !== 'transfer' && sameAmount.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setMode('pick')}>{t('money.inbox.pickOther')}</Button>
            )}
            <Button size="sm" variant="ghost" className={cn('text-muted')} disabled={busy} onClick={() => void ignore()}>
              <X className="h-4 w-4" aria-hidden />
              {t('money.inbox.ignore')}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
