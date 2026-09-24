import { Banknote, CreditCard, Landmark, PiggyBank, TrendingUp, Wallet, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatLKR } from '@/lib/money/format';
import { subsOf, type CategoryRow } from '@/lib/money/categoriesMap';
import type { Account, AccountKind, TxType } from '@/lib/money/queries';
import { cn } from '@/lib/utils';

export const fieldLabel = 'mb-1.5 block text-[13px] font-medium text-muted';
export const selectClass =
  'h-12 w-full rounded-[14px] border border-line-2 bg-[#0d1326] px-3.5 text-[16px] text-text focus:border-accent-a focus:outline-none';

export const ACCOUNT_ICON: Record<AccountKind, LucideIcon> = {
  cash: Banknote,
  bank: Landmark,
  credit_card: CreditCard,
  wallet: Wallet,
  loan: PiggyBank,
  investment: TrendingUp,
};

/** Sign of an amount as it affects the household: money out is negative. */
export function signedTotal(type: string, total: number): number {
  return type === 'expense' ? -total : type === 'transfer' ? 0 : total;
}

/** Always mono + tabular (rule 11). `tone` colours income teal; money out stays plain text. */
export function Money({
  value,
  className,
  tone = false,
  plus = false,
  whole = false,
}: {
  value: number;
  className?: string;
  tone?: boolean;
  plus?: boolean;
  whole?: boolean;
}) {
  const text = formatLKR(Math.abs(value), { whole });
  return (
    <span className={cn('tabular whitespace-nowrap', tone && value > 0 && 'text-teal', className)}>
      {value < 0 ? '−' : plus && value > 0 ? '+' : ''}
      {text}
    </span>
  );
}

export function AccountDot({ account, className }: { account: Pick<Account, 'color' | 'kind'>; className?: string }) {
  const Icon = ACCOUNT_ICON[account.kind as AccountKind] ?? Wallet;
  return (
    <span
      className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', className)}
      style={{
        background: `color-mix(in srgb, ${account.color ?? 'var(--accent-a)'} 20%, transparent)`,
        color: account.color ?? 'var(--accent-a)',
      }}
      aria-hidden
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}

/** Native select grouped by top-level category (optgroups read well on phones). */
export function CategorySelect({
  id,
  categories,
  value,
  onChange,
  kind,
  required,
  className,
}: {
  id?: string;
  categories: CategoryRow[];
  value: string | null;
  onChange: (id: string | null) => void;
  kind: 'expense' | 'income';
  required?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const tops = categories
    .filter((c) => c.parent_id === null && (c.kind === kind || c.kind === 'both') && (!c.archived || c.id === value))
    .sort((a, b) => a.sort - b.sort);
  return (
    <select
      id={id}
      required={required}
      className={cn(selectClass, className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{t('money.form.pickCategory')}</option>
      {tops.map((top) => (
        <optgroup key={top.id} label={`${top.icon ?? ''} ${top.name}`.trim()}>
          <option value={top.id}>{t('money.form.generalIn', { name: top.name })}</option>
          {subsOf(categories, top.id)
            .filter((s) => !s.archived || s.id === value)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  exclude,
  className,
}: {
  id?: string;
  accounts: Account[];
  value: string | null;
  onChange: (id: string) => void;
  exclude?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <select
      id={id}
      required
      className={cn(selectClass, className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        {t('money.form.pickAccount')}
      </option>
      {accounts
        .filter((a) => a.id !== exclude)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.last4 ? ` ··${a.last4}` : ''}
          </option>
        ))}
    </select>
  );
}

export function TypeBadge({ type }: { type: TxType | string }) {
  const { t } = useTranslation();
  if (type === 'expense') return null;
  const tone =
    type === 'income' || type === 'refund'
      ? 'bg-teal/15 text-teal'
      : type === 'transfer'
        ? 'bg-due/15 text-due'
        : 'bg-info/15 text-info';
  return (
    <span className={cn('tabular rounded-full px-2 py-0.5 text-[10.5px] tracking-wide uppercase', tone)}>
      {t(`money.types.${type as TxType}`)}
    </span>
  );
}
