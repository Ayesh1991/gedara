import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountForm } from '@/components/money/AccountForms';
import { AccountCard } from '@/components/money/AccountCard';
import { Money } from '@/components/money/bits';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { sumAmounts } from '@/lib/money/format';
import type { Account } from '@/lib/money/queries';

export const Route = createFileRoute('/_app/money/accounts/')({
  component: AccountsPage,
});

function AccountsPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const { accounts } = useMoneyBasics(householdId);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const all = accounts.data ?? [];
  const live = all.filter((a) => !a.archived);
  const groups: Array<{ key: string; title: string; items: Account[] }> = [
    { key: 'money', title: t('money.accounts.groupMoney'), items: live.filter((a) => !a.is_suspense && a.kind !== 'credit_card' && a.kind !== 'loan') },
    { key: 'cards', title: t('money.accounts.groupCards'), items: live.filter((a) => !a.is_suspense && (a.kind === 'credit_card' || a.kind === 'loan')) },
    { key: 'match', title: t('money.accounts.groupMatch'), items: live.filter((a) => a.is_suspense) },
  ];
  const setUp = live.filter((a) => a.isSetUp && !a.is_suspense);
  const netWorth = sumAmounts(setUp.map((a) => a.balance));
  const archived = all.filter((a) => a.archived);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/money" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.money')}
      </Link>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('money.accounts.title')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('money.accounts.intro')}</p>
        </div>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('money.accounts.add')}
          </Button>
        )}
      </div>

      {setUp.length > 0 && (
        <Card className="flex items-baseline justify-between gap-3">
          <span className="text-[14px] text-muted">{t('money.accounts.netPosition', { count: setUp.length })}</span>
          <Money value={netWorth} className="text-[24px] font-semibold" />
        </Card>
      )}

      {accounts.isPending ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : accounts.isError ? (
        <Card className="text-[14px] text-red">{t('money.loadError')}</Card>
      ) : (
        groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.key} className="flex flex-col gap-2.5">
              <h2 className="px-1 text-[12.5px] tracking-wide text-muted uppercase">{g.title}</h2>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {g.items.map((a) => (
                  <AccountCard key={a.id} account={a} />
                ))}
              </div>
            </section>
          ))
      )}

      {archived.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            className="flex items-center gap-1 self-start text-[13.5px] text-muted hover:text-text"
            onClick={() => setShowArchived((s) => !s)}
          >
            {t('money.accounts.archived', { count: archived.length })}
            <ChevronRight className={showArchived ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} aria-hidden />
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 gap-2.5 opacity-70 md:grid-cols-2">
              {archived.map((a) => (
                <AccountCard key={a.id} account={a} />
              ))}
            </div>
          )}
        </div>
      )}

      <AccountForm open={adding} onClose={() => setAdding(false)} householdId={householdId} />
    </div>
  );
}
