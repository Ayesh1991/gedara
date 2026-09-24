import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Account } from '@/lib/money/queries';
import { cn } from '@/lib/utils';
import { AccountDot, Money } from './bits';

/** Balance summary. Cards: owed + available + how much of the limit is used. */
export function AccountBalance({ account, large = false }: { account: Account; large?: boolean }) {
  const { t } = useTranslation();
  const size = large ? 'text-[30px] font-semibold tracking-tight' : 'text-[19px] font-medium';

  if (account.is_suspense) {
    return (
      <div className="flex flex-col gap-1">
        <span className={cn('tabular text-caution', size)}>{t('money.accounts.toMatch', { count: account.transactionCount })}</span>
        <span className="text-[12.5px] text-muted">
          <Money value={-account.balance} /> · {t('money.accounts.toMatchHint')}
        </span>
      </div>
    );
  }
  if (!account.isSetUp) {
    return <span className="text-[14px] text-due">{t('money.accounts.notSetUp')}</span>;
  }
  const isCard = account.kind === 'credit_card' || account.kind === 'loan';
  if (!isCard) return <Money value={account.balance} className={size} />;

  const owed = Math.max(0, -account.balance);
  const limit = account.credit_limit;
  const used = limit ? Math.min(1, owed / limit) : 0;
  const tone = used >= 0.9 ? 'var(--red)' : used >= 0.6 ? 'var(--caution)' : 'var(--teal)';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <Money value={owed} className={size} />
        <span className="text-[12.5px] text-muted">{t('money.accounts.owed')}</span>
      </div>
      {limit != null && (
        <>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={owed}
            aria-label={t('money.accounts.limitUsed')}
          >
            <div className="h-full rounded-full" style={{ width: `${used * 100}%`, background: tone }} />
          </div>
          <span className="tabular text-[12.5px] text-muted">
            {t('money.accounts.availableOf', {
              available: new Intl.NumberFormat('en-LK', { maximumFractionDigits: 0 }).format(account.available ?? limit - owed),
              limit: new Intl.NumberFormat('en-LK', { maximumFractionDigits: 0 }).format(limit),
            })}
          </span>
        </>
      )}
    </div>
  );
}

export function AccountCard({ account }: { account: Account }) {
  return (
    <Link
      to="/money/accounts/$accountId"
      params={{ accountId: account.id }}
      className="glass flex items-start gap-3.5 rounded-[var(--r)] p-4 transition-colors hover:border-white/25"
    >
      <AccountDot account={account} className="h-11 w-11" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-display text-[16px] font-semibold">{account.name}</span>
          {account.last4 && <span className="tabular text-[12px] text-faint">··{account.last4}</span>}
        </div>
        <AccountBalance account={account} />
      </div>
    </Link>
  );
}
