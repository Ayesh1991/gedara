import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JournalList } from '@/components/pantry/JournalList';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { journalQuery } from '@/lib/pantry/queries';

export const Route = createFileRoute('/_app/pantry/journal')({
  component: JournalPage,
});

const PAGE = 80;

/** The stock journal (Grocy's "stock journal" with undo): every movement, newest first. */
function JournalPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const [limit, setLimit] = useState(PAGE);
  const journal = useQuery(journalQuery(householdId, undefined, limit));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/pantry" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.pantry')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('pantry.journal.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('pantry.journal.intro')}</p>
      </div>
      {journal.isError ? (
        <Card className="text-[14px] text-red">{t('pantry.loadError')}</Card>
      ) : !journal.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : (
        <>
          <JournalList
            rows={journal.data}
            householdId={householdId}
            canWrite={membership.role !== 'viewer'}
            showProduct
            locale={locale}
          />
          {journal.data.length >= limit && (
            <Button className="self-center" onClick={() => setLimit((l) => l + PAGE)}>
              {t('pantry.journal.more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
