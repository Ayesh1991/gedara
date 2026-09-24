import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowRightLeft, ChevronLeft, CircleAlert, CircleCheck, ListChecks, MessageSquareText, Pencil, Scale, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AccountBalance } from '@/components/money/AccountCard';
import { AccountForm, BalanceForm } from '@/components/money/AccountForms';
import { AccountDot, AccountSelect, Money } from '@/components/money/bits';
import { TransactionList } from '@/components/money/TransactionList';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  accountTransactionsQuery,
  invalidateMoney,
  moneyErrorKey,
  moveTransactions,
  pickableAccounts,
} from '@/lib/money/queries';
import { smsBalanceQuery } from '@/lib/sms/queries';
import { formatDay, todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/money/accounts/$accountId')({
  component: AccountPage,
});

function AccountPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { accountId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const { accounts, categories } = useMoneyBasics(householdId);
  const txs = useQuery(accountTransactionsQuery(householdId, accountId));
  const bankSays = useQuery(smsBalanceQuery(householdId)).data?.get(accountId);
  const [form, setForm] = useState<'edit' | 'opening' | 'reconcile' | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayIn(timezone);

  const account = accounts.data?.find((a) => a.id === accountId);
  if (accounts.isPending || categories.isPending) {
    return <div className="glass h-48 animate-pulse rounded-[var(--r)]" aria-hidden />;
  }
  if (!account || !accounts.data || !categories.data) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p>{t('money.accounts.notFound')}</p>
        <Link to="/money/accounts" className="text-accent-b underline">
          {t('money.accounts.title')}
        </Link>
      </Card>
    );
  }

  const movable = (txs.data ?? []).filter((tx) => tx.account_id === accountId && tx.type !== 'transfer' && tx.type !== 'adjustment');
  const targets = pickableAccounts(accounts.data).filter((a) => a.id !== accountId);

  async function move() {
    if (!target || selected.size === 0) return;
    setBusy(true);
    try {
      const n = await moveTransactions([...selected], target);
      await invalidateMoney(qc, householdId);
      toast.success(t('money.accounts.moved', { count: n, name: targets.find((a) => a.id === target)?.name ?? '' }));
      setSelected(new Set());
      setSelecting(false);
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/money/accounts" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('money.accounts.title')}
      </Link>

      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <AccountDot account={account} className="h-12 w-12" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[24px] font-semibold">{account.name}</h1>
            <p className="tabular text-[13px] text-muted">
              {[t(`money.kinds.${account.kind as 'cash'}`), account.institution, account.last4 ? `··${account.last4}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {canWrite && (
            <Button variant="ghost" size="icon" aria-label={t('money.accounts.editTitle')} onClick={() => setForm('edit')}>
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
        <AccountBalance account={account} large />
        {bankSays && account.isSetUp && bankSays.gedara_value !== null && (
          <p
            className={`flex items-start gap-2 text-[13px] ${Math.round(bankSays.bank_reported * 100) === Math.round(bankSays.gedara_value * 100) ? 'text-teal' : 'text-caution'}`}
          >
            {Math.round(bankSays.bank_reported * 100) === Math.round(bankSays.gedara_value * 100) ? (
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>
              {t(account.credit_limit !== null ? 'money.inbox.bankSaysAvailable' : 'money.inbox.bankSaysBalance', {
                when: formatDay(bankSays.reported_at.slice(0, 10), locale, today.slice(0, 4)),
              })}{' '}
              <Money value={bankSays.bank_reported} className="font-medium" />
              {Math.round(bankSays.bank_reported * 100) !== Math.round(bankSays.gedara_value * 100) && (
                <>
                  {' · '}
                  {t('money.inbox.gedaraSays')} <Money value={bankSays.gedara_value} />
                </>
              )}
            </span>
          </p>
        )}
        {account.isSetUp && account.opening_on && !account.is_suspense && (
          <p className="text-[12.5px] text-faint">
            {t('money.accounts.countingFrom', { date: formatDay(account.opening_on, locale, today.slice(0, 4)) })}
          </p>
        )}
        {canWrite && !account.is_suspense && (
          <div className="flex flex-wrap gap-2.5">
            {account.isSetUp ? (
              <Button size="sm" onClick={() => setForm('reconcile')}>
                <Scale className="h-4 w-4" aria-hidden />
                {t('money.balance.reconcileTitle')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setForm('opening')}>
                {t('money.balance.openingTitle')}
              </Button>
            )}
            {account.isSetUp && (
              <Button variant="ghost" size="sm" onClick={() => setForm('opening')}>
                {t('money.balance.changeOpening')}
              </Button>
            )}
          </div>
        )}
      </Card>

      {account.is_suspense && canWrite && movable.length > 0 && (
        <Card className="flex flex-col gap-3 border-caution/30">
          <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('money.accounts.matchHelp')}</p>
          <Link to="/money/inbox" className={buttonVariants({ variant: 'accent', size: 'sm', className: 'self-start' })}>
            <MessageSquareText className="h-4 w-4" aria-hidden />
            {t('money.inbox.matchFromAlerts')}
          </Link>
          <Button
            size="sm"
            className="self-start"
            onClick={() => {
              setSelecting((s) => !s);
              setSelected(new Set());
            }}
          >
            {selecting ? <X className="h-4 w-4" aria-hidden /> : <ListChecks className="h-4 w-4" aria-hidden />}
            {selecting ? t('common.cancel') : t('money.accounts.selectToMove')}
          </Button>
        </Card>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="px-1 font-display text-[17px] font-semibold">{t('money.accounts.history')}</h2>
        {txs.isPending ? (
          <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
        ) : txs.isError ? (
          <Card className="text-[14px] text-red">{t('money.loadError')}</Card>
        ) : (txs.data?.length ?? 0) === 0 ? (
          <Card className="text-center text-[14.5px] text-muted">{t('money.accounts.noHistory')}</Card>
        ) : (
          <TransactionList
            transactions={selecting ? movable : txs.data}
            accounts={accounts.data}
            categories={categories.data}
            locale={locale}
            today={today}
            perspective={accountId}
            selectable={selecting}
            selected={selected}
            onToggle={(id) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        )}
      </section>

      {selecting && (
        <div className="sticky bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+1.75rem)] z-20 lg:bottom-6">
          <div className="glass-strong slide-up mx-auto flex max-w-lg flex-col gap-2.5 rounded-3xl p-3">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="tabular text-[14px]">{t('money.accounts.selected', { count: selected.size })}</span>
              <button
                type="button"
                className="text-[13px] text-accent-b"
                onClick={() => setSelected(new Set(selected.size === movable.length ? [] : movable.map((m) => m.id)))}
              >
                {t(selected.size === movable.length ? 'money.accounts.selectNone' : 'money.accounts.selectAll')}
              </button>
            </div>
            <div className="flex gap-2">
              <AccountSelect accounts={targets} value={target} onChange={setTarget} className="h-11" />
              <Button variant="primary" size="sm" className="h-11 shrink-0" disabled={!target || !selected.size || busy} onClick={() => void move()}>
                <ArrowRightLeft className="h-4 w-4" aria-hidden />
                {t('money.accounts.move')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <AccountForm open={form === 'edit'} onClose={() => setForm(null)} householdId={householdId} account={account} />
      <BalanceForm
        open={form === 'opening' || form === 'reconcile'}
        onClose={() => setForm(null)}
        householdId={householdId}
        timezone={timezone}
        account={account}
        mode={form === 'reconcile' ? 'reconcile' : 'opening'}
      />
    </div>
  );
}
