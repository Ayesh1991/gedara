import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { BillImport } from '@/components/money/BillImport';
import { SheetImport } from '@/components/money/SheetImport';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Card } from '@/components/ui/card';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({ tab: z.enum(['bill', 'sheet']).optional() });

export const Route = createFileRoute('/_app/money/import')({
  validateSearch: SearchSchema,
  component: ImportPage,
});

function ImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: '/money/import' });
  const { tab = 'bill' } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const { accounts, categories } = useMoneyBasics(householdId);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/money" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.money')}
      </Link>
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('money.import.title')}</h1>

      <div role="tablist" aria-label={t('money.import.title')} className="grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
        {(['bill', 'sheet'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => void navigate({ search: { tab: k }, replace: true })}
            className={cn('h-11 rounded-xl font-display text-[14.5px] font-medium text-muted', tab === k && 'accent-pill text-text')}
          >
            {t(k === 'bill' ? 'money.import.billTab' : 'money.import.sheetTab')}
          </button>
        ))}
      </div>

      {membership.role === 'viewer' ? (
        <Card className="text-[14px] text-muted">{t('money.errors.denied')}</Card>
      ) : !accounts.data || !categories.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : tab === 'bill' ? (
        <BillImport
          householdId={householdId}
          locale={locale}
          today={todayIn(timezone)}
          accounts={accounts.data}
          categories={categories.data}
        />
      ) : (
        <SheetImport householdId={householdId} locale={locale} accounts={accounts.data} categories={categories.data} />
      )}
    </div>
  );
}
