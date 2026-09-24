import { Link } from '@tanstack/react-router';
import { ArrowLeftRight, ChevronRight, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { categoryLabel, topOf, type CategoryRow } from '@/lib/money/categoriesMap';
import { sumAmounts } from '@/lib/money/format';
import type { Account, Transaction } from '@/lib/money/queries';
import { formatDay } from '@/lib/time';
import { Money, TypeBadge, signedTotal } from './bits';

/** Ledger-style list: one row per bill, grouped by day with the day's net. */
export function TransactionList({
  transactions,
  accounts,
  categories,
  locale,
  today,
  selectable,
  selected,
  onToggle,
  perspective,
}: {
  transactions: Transaction[];
  accounts: Account[];
  categories: CategoryRow[];
  locale: string;
  today: string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  /** Account page: transfers show as in/out of this account. */
  perspective?: string;
}) {
  const days: Array<{ day: string; items: Transaction[] }> = [];
  for (const tx of transactions) {
    const last = days.at(-1);
    if (last?.day === tx.occurred_on) last.items.push(tx);
    else days.push({ day: tx.occurred_on, items: [tx] });
  }
  const effect = (tx: Transaction) => {
    if (perspective && tx.type === 'transfer') return tx.account_id === perspective ? -tx.total : tx.total;
    return signedTotal(tx.type, tx.total);
  };

  return (
    <div className="flex flex-col gap-4">
      {days.map(({ day, items }) => (
        <section key={day} aria-label={formatDay(day, locale, today.slice(0, 4))}>
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h3 className="tabular text-[12.5px] tracking-wide text-muted uppercase">
              {formatDay(day, locale, today.slice(0, 4))}
            </h3>
            <Money value={sumAmounts(items.map(effect))} className="text-[12.5px] text-muted" plus />
          </div>
          <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
            {items.map((tx) => (
              <li key={tx.id}>
                <Row
                  tx={tx}
                  value={effect(tx)}
                  accounts={accounts}
                  categories={categories}
                  selectable={selectable}
                  checked={selected?.has(tx.id) ?? false}
                  onToggle={onToggle}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({
  tx,
  value,
  accounts,
  categories,
  selectable,
  checked,
  onToggle,
}: {
  tx: Transaction;
  value: number;
  accounts: Account[];
  categories: CategoryRow[];
  selectable?: boolean;
  checked: boolean;
  onToggle?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const account = accounts.find((a) => a.id === tx.account_id);
  const to = accounts.find((a) => a.id === tx.to_account_id);
  const first = tx.lines[0];
  const top = topOf(categories, first?.category_id);
  const title =
    tx.type === 'transfer'
      ? t('money.list.transfer', { from: account?.name ?? '?', to: to?.name ?? '?' })
      : tx.payee_text || first?.raw_name || t(`money.types.${tx.type as 'expense'}`);
  const sub =
    tx.type === 'transfer' || tx.type === 'adjustment'
      ? account?.name
      : tx.lines.length > 1
        ? t('money.list.items', { count: tx.lines.length, category: top?.name ?? '' })
        : categoryLabel(categories, first?.category_id) || first?.raw_name;

  const icon =
    tx.type === 'transfer' ? (
      <ArrowLeftRight className="h-[18px] w-[18px]" aria-hidden />
    ) : tx.type === 'adjustment' ? (
      <Scale className="h-[18px] w-[18px]" aria-hidden />
    ) : (
      <span aria-hidden>{top?.icon ?? '•'}</span>
    );

  const body = (
    <>
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[18px]"
        style={{ background: `color-mix(in srgb, ${top?.color ?? 'var(--accent-a)'} 16%, transparent)` }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          <TypeBadge type={tx.type} />
        </span>
        <span className="block truncate text-[12.5px] text-muted">
          {[tx.occurred_at?.slice(0, 5), sub, tx.type !== 'transfer' ? account?.name : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Money value={value} tone plus className="text-[14px] sm:text-[15px]" />
    </>
  );

  if (selectable) {
    return (
      <label className="flex min-h-16 cursor-pointer items-center gap-3 px-4 py-3 hover:bg-white/[0.03]">
        <input
          type="checkbox"
          className="h-5 w-5 shrink-0 accent-[var(--accent-a)]"
          checked={checked}
          onChange={() => onToggle?.(tx.id)}
        />
        {body}
      </label>
    );
  }
  return (
    <Link
      to="/money/tx/$txId"
      params={{ txId: tx.id }}
      className="flex min-h-16 items-center gap-3 px-3.5 py-3 transition-colors hover:bg-white/[0.03] sm:px-4"
    >
      {body}
      <ChevronRight className="hidden h-4 w-4 shrink-0 text-faint sm:block" aria-hidden />
    </Link>
  );
}
