import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { BillImport } from '@/components/money/BillImport';
import { SheetImport } from '@/components/money/SheetImport';
import { SmsBackupImport } from '@/components/money/SmsBackupImport';
import { DriveInbox } from '@/components/scan/DriveInbox';
import { useSharedText } from '@/components/scan/useSharedText';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Card } from '@/components/ui/card';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({ tab: z.enum(['drive', 'bill', 'sheet', 'sms']).optional(), shared: z.coerce.number().optional() });

export const Route = createFileRoute('/_app/money/import')({
  validateSearch: SearchSchema,
  component: ImportPage,
});

function ImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: '/money/import' });
  const { tab = 'bill', shared } = Route.useSearch();
  // Text shared from another app (Android share sheet → the service worker keeps it for one read).
  const sharedText = useSharedText(shared);
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

      <div role="tablist" aria-label={t('money.import.title')} className="grid grid-cols-4 gap-1 rounded-2xl bg-white/5 p-1">
        {(['drive', 'bill', 'sheet', 'sms'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => void navigate({ search: { tab: k }, replace: true })}
            className={cn('min-h-11 rounded-xl px-1 py-1 font-display text-[13px] leading-tight font-medium text-muted sm:text-[14.5px]', tab === k && 'accent-pill text-text')}
          >
            {t(k === 'drive' ? 'scanInbox.tab' : k === 'bill' ? 'money.import.billTab' : k === 'sheet' ? 'money.import.sheetTab' : 'money.import.smsTab')}
          </button>
        ))}
      </div>

      {membership.role === 'viewer' ? (
        <Card className="text-[14px] text-muted">{t('money.errors.denied')}</Card>
      ) : !accounts.data || !categories.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : tab === 'drive' ? (
        <DriveInbox
          householdId={householdId}
          locale={locale}
          today={todayIn(timezone)}
          accounts={accounts.data}
          categories={categories.data}
          isOwner={membership.role === 'owner'}
        />
      ) : tab === 'sms' ? (
        <SmsBackupImport householdId={householdId} />
      ) : tab === 'bill' ? (
        <BillImport
          householdId={householdId}
          locale={locale}
          today={todayIn(timezone)}
          accounts={accounts.data}
          categories={categories.data}
          key={sharedText ? `shared-${shared}` : 'blank'}
          initialText={sharedText}
        />
      ) : (
        <SheetImport householdId={householdId} locale={locale} accounts={accounts.data} categories={categories.data} />
      )}
    </div>
  );
}
