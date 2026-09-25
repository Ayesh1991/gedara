import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { JournalList } from '@/components/pantry/JournalList';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { journalQuery } from '@/lib/pantry/queries';
import { textParam } from '@/lib/search';
import { formatDay } from '@/lib/time';

const day = () => textParam(10).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
/** Filters Insights links here with (the record level of the pantry numbers). */
const SearchSchema = z.object({
  product: textParam(36).pipe(z.string().uuid()).optional(),
  reason: z.enum(['purchase', 'consume', 'waste']).optional(),
  from: day().optional(),
  to: day().optional(),
});

export const Route = createFileRoute('/_app/pantry/journal')({
  validateSearch: SearchSchema,
  component: JournalPage,
});

const PAGE = 80;

/** The stock journal (Grocy's "stock journal" with undo): every movement, newest first. */
function JournalPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const [limit, setLimit] = useState(PAGE);
  const search = Route.useSearch();
  const filtered = !!(search.product || search.reason || search.from || search.to);
  const journal = useQuery(
    journalQuery(householdId, search.product, limit, { reason: search.reason, from: search.from, to: search.to }),
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/pantry" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.pantry')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('pantry.journal.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('pantry.journal.intro')}</p>
        {filtered && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded-full bg-white/[0.06] px-3 py-1">
              {[
                search.product && journal.data?.[0]?.product_name,
                search.reason && t(`pantry.journal.filter.${search.reason}`),
                search.from && search.to && `${formatDay(search.from, locale)} – ${formatDay(search.to, locale)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Link to="/pantry/journal" className="text-accent-b hover:underline">
              {t('pantry.journal.filter.clear')}
            </Link>
          </p>
        )}
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
