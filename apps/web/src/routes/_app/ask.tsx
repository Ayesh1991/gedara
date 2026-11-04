import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { AskPanel } from '@/components/ask/AskPanel';
import { Card } from '@/components/ui/card';
import { askStatusQuery } from '@/lib/ask/queries';
import { textParam } from '@/lib/search';

const SearchSchema = z.object({ q: textParam(300).optional() });

export const Route = createFileRoute('/_app/ask')({
  validateSearch: SearchSchema,
  component: AskPage,
});

/** Ask Gedara (Phase 10): a question in plain words, answered from the household's own data, read-only. */
function AskPage() {
  const { t } = useTranslation();
  const { q } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const status = useQuery(askStatusQuery(householdId));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="brand-gradient grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-[#05070F]" aria-hidden>
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">{t('ask.title')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('ask.intro')}</p>
        </div>
        <Link to="/settings/ask" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-white/5 hover:text-text" aria-label={t('settings.title')}>
          <Settings2 className="h-5 w-5" aria-hidden />
        </Link>
      </div>

      {status.data && !status.data.enabled ? (
        <Card className="text-[14.5px] text-muted">{t('ask.errors.off')}</Card>
      ) : (
        <Card>
          <AskPanel key={q ?? ''} householdId={householdId} householdLocale={locale} initial={q ?? ''} autoAsk={!!q} />
        </Card>
      )}
    </div>
  );
}
