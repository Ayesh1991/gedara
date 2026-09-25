import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AreaView } from '@/components/insights/areas';
import { PeriodBar } from '@/components/insights/PeriodBar';
import { AREAS, InsightsSearchSchema, periodOf, type Area } from '@/lib/insights/drill';
import { todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/insights/$area')({
  params: {
    parse: (p) => {
      if (!(AREAS as readonly string[]).includes(p.area)) throw notFound();
      return { area: p.area as Area };
    },
    stringify: (p) => ({ area: p.area }),
  },
  validateSearch: InsightsSearchSchema,
  component: AreaPage,
});

/** One area of §6 — the drill path is the URL (from, to, cat, sub, product | name …). */
function AreaPage() {
  const { t } = useTranslation();
  const { area } = Route.useParams();
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { timezone } = membership.household;
  const today = todayIn(timezone);
  const period = periodOf(search, today);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/insights" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.insights')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t(`insights.areas.${area}.title`)}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t(`insights.areas.${area}.intro`)}</p>
      </div>
      {area !== 'things' && area !== 'places' && <PeriodBar area={area} search={search} period={period} today={today} />}
      <AreaView area={area} search={search} period={period} membership={membership} today={today} />
    </div>
  );
}
