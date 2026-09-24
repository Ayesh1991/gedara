import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, FileUp, Plus, Search, Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { StatTile } from '@/components/aurora/StatTile';
import { AccountDot, Money, selectClass } from '@/components/money/bits';
import { TransactionForm } from '@/components/money/TransactionForm';
import { TransactionList } from '@/components/money/TransactionList';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { subsOf } from '@/lib/money/categoriesMap';
import { cashflowQuery, monthTransactionsQuery, type Account } from '@/lib/money/queries';
import { addMonths, formatMonth, todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  account: z.string().optional(),
  cat: z.string().optional(),
  q: z.string().max(80).optional(),
  add: z.enum(['expense', 'income', 'transfer']).optional(),
});

export const Route = createFileRoute('/_app/money/')({
  validateSearch: SearchSchema,
  component: MoneyPage,
});

function MoneyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: '/money/' });
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const month = search.month ?? today.slice(0, 7);

  const { accounts, categories, merchants } = useMoneyBasics(householdId);
  const txs = useQuery(monthTransactionsQuery(householdId, month));
  const flow = useQuery(cashflowQuery(householdId));
  const thisMonth = flow.data?.find((f) => f.month === month);
  const hasAnything = (flow.data?.length ?? 0) > 0 || (txs.data?.length ?? 0) > 0;

  const setSearch = (patch: Partial<z.infer<typeof SearchSchema>>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const filtered = useMemo(() => {
    const cats = categories.data ?? [];
    const catIds = search.cat
      ? new Set([search.cat, ...subsOf(cats, search.cat).map((c) => c.id)])
      : null;
    const q = search.q?.trim().toLowerCase();
    return (txs.data ?? []).filter(
      (tx) =>
        (!search.account || tx.account_id === search.account || tx.to_account_id === search.account) &&
        (!catIds || tx.lines.some((l) => l.category_id && catIds.has(l.category_id))) &&
        (!q ||
          (tx.payee_text ?? '').toLowerCase().includes(q) ||
          tx.lines.some((l) => l.raw_name.toLowerCase().includes(q)) ||
          (tx.notes ?? '').toLowerCase().includes(q)),
    );
  }, [txs.data, categories.data, search.account, search.cat, search.q]);

  const tops = (categories.data ?? []).filter((c) => c.parent_id === null).sort((a, b) => a.sort - b.sort);
  const visibleAccounts = (accounts.data ?? []).filter((a) => !a.archived);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.money')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('money.intro')}</p>
        </div>
        <div className="flex gap-2.5">
          {canWrite && (
            <Link to="/money/import" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <FileUp className="h-4 w-4" aria-hidden />
              {t('money.import.title')}
            </Link>
          )}
          {canWrite && (
            <Button variant="primary" size="sm" onClick={() => setSearch({ add: 'expense' })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('money.add')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('money.prevMonth')}
          onClick={() => setSearch({ month: addMonths(month, -1) })}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h2 className="font-display text-[19px] font-semibold">{formatMonth(month, locale)}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('money.nextMonth')}
          disabled={month >= today.slice(0, 7)}
          onClick={() => setSearch({ month: addMonths(month, 1) })}
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </Button>
      </div>

      <section aria-label={t('money.summary')} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4">
        <StatTile
          label={t('money.in')}
          value={flow.isPending ? '…' : <Money value={thisMonth?.income ?? 0} whole className="text-[19px] sm:text-[21px] lg:text-[24px]" />}
          empty={!thisMonth?.income}
        />
        <StatTile label={t('money.out')} value={flow.isPending ? '…' : <Money value={thisMonth?.spent ?? 0} whole className="text-[19px] sm:text-[21px] lg:text-[24px]" />} empty={!thisMonth?.spent} />
        <div className="col-span-2 sm:col-span-1">
        <StatTile
          highlight
          label={t('money.net')}
          value={flow.isPending ? '…' : <Money value={thisMonth?.net ?? 0} whole className="text-[19px] sm:text-[21px] lg:text-[24px]" />}
          empty={!thisMonth}
          footer={thisMonth ? t('money.bills', { count: thisMonth.bills }) : undefined}
        />
        </div>
      </section>

      {visibleAccounts.length > 0 && <AccountStrip accounts={visibleAccounts} />}

      {!txs.isPending && !hasAnything ? (
        <EmptyLedger canWrite={canWrite} onAdd={() => setSearch({ add: 'expense' })} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1.4fr_1fr_1fr]">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                type="search"
                aria-label={t('money.filters.search')}
                placeholder={t('money.filters.search')}
                className="pl-10"
                value={search.q ?? ''}
                onChange={(e) => setSearch({ q: e.target.value || undefined })}
              />
            </div>
            <select
              aria-label={t('money.filters.account')}
              className={selectClass}
              value={search.account ?? ''}
              onChange={(e) => setSearch({ account: e.target.value || undefined })}
            >
              <option value="">{t('money.filters.allAccounts')}</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('money.filters.category')}
              className={selectClass}
              value={search.cat ?? ''}
              onChange={(e) => setSearch({ cat: e.target.value || undefined })}
            >
              <option value="">{t('money.filters.allCategories')}</option>
              {tops.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.icon ?? ''} ${c.name}`.trim()}
                </option>
              ))}
            </select>
          </div>

          {txs.isPending || !accounts.data || !categories.data ? (
            <ListSkeleton />
          ) : txs.isError ? (
            <Card className="text-[14px] text-red">{t('money.loadError')}</Card>
          ) : filtered.length === 0 ? (
            <Card className="text-center text-[14.5px] text-muted">
              {txs.data.length === 0 ? t('money.emptyMonth') : t('money.noMatches')}
            </Card>
          ) : (
            <TransactionList
              transactions={filtered}
              accounts={accounts.data}
              categories={categories.data}
              locale={locale}
              today={today}
            />
          )}
        </>
      )}

      {accounts.data && categories.data && (
        <TransactionForm
          open={Boolean(search.add)}
          onClose={() => setSearch({ add: undefined })}
          householdId={householdId}
          timezone={timezone}
          accounts={accounts.data}
          categories={categories.data}
          merchants={merchants.data ?? []}
          initialType={search.add}
          onSaved={() => undefined}
        />
      )}
    </div>
  );
}

function AccountStrip({ accounts }: { accounts: Account[] }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('money.accounts.title')} className="-mx-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
      <ul className="flex gap-2.5">
        {accounts.map((a) => (
          <li key={a.id} className="shrink-0">
            <Link
              to="/money/accounts/$accountId"
              params={{ accountId: a.id }}
              className="glass flex w-44 items-center gap-2.5 rounded-2xl px-3 py-2.5 transition-colors hover:border-white/25"
            >
              <AccountDot account={a} className="h-8 w-8" />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-muted">{a.name}</span>
                {a.is_suspense ? (
                  <span className="tabular block text-[13px] text-caution">
                    {t('money.accounts.toMatch', { count: a.transactionCount })}
                  </span>
                ) : a.isSetUp ? (
                  <Money value={a.balance} className={cn('block text-[14px]', a.balance < 0 && 'text-text')} whole />
                ) : (
                  <span className="block text-[13px] text-due">{t('money.accounts.setBalance')}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
        <li className="shrink-0">
          <Link
            to="/money/accounts"
            className="flex h-full w-32 items-center justify-center gap-1 rounded-2xl border border-dashed border-line-2 px-3 text-[13px] text-muted hover:text-text"
          >
            {t('money.accounts.all')}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </li>
      </ul>
    </section>
  );
}

function EmptyLedger({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="relative flex flex-col items-center gap-4 overflow-hidden px-6 py-10 text-center">
      <div
        aria-hidden
        className="absolute -top-20 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: 'var(--glow)' }}
      />
      <div className="brand-gradient relative flex h-16 w-16 items-center justify-center rounded-3xl text-[#05070F]">
        <Wallet className="h-8 w-8" aria-hidden />
      </div>
      <div className="relative max-w-md">
        <h2 className="font-display text-[20px] font-semibold">{t('money.emptyTitle')}</h2>
        <p className="mt-1.5 text-[14.5px] leading-relaxed text-[#a5b0d0]">{t('money.emptyBody')}</p>
      </div>
      {canWrite && (
        <div className="relative flex flex-wrap justify-center gap-2.5">
          <Link to="/money/import" search={{ tab: 'sheet' }} className={buttonVariants({ variant: 'secondary' })}>
            <FileUp className="h-[18px] w-[18px]" aria-hidden />
            {t('money.import.sheetTab')}
          </Link>
          <Button variant="primary" onClick={onAdd}>
            <Plus className="h-[18px] w-[18px]" aria-hidden />
            {t('money.addFirst')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="glass h-16 animate-pulse rounded-[var(--r)]" />
      ))}
    </div>
  );
}
