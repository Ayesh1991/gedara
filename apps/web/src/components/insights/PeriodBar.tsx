import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clean, crumbs, type Area, type InsightsSearch, type Period } from '@/lib/insights/drill';
import { addMonths, formatMonth } from '@/lib/time';
import { cn } from '@/lib/utils';

type Preset = 'month' | 'lastMonth' | 'three' | 'twelve' | 'year';

function presetPeriod(p: Preset, today: string): Period {
  const m = today.slice(0, 7);
  switch (p) {
    case 'month':
      return { from: m, to: m };
    case 'lastMonth':
      return { from: addMonths(m, -1), to: addMonths(m, -1) };
    case 'three':
      return { from: addMonths(m, -2), to: m };
    case 'year':
      return { from: `${m.slice(0, 4)}-01`, to: m };
    default:
      return { from: addMonths(m, -11), to: m };
  }
}

/** Period chips (one row, above the charts); the rest of the drill path is kept. */
export function PeriodBar({ area, search, period, today }: { area: Area; search: InsightsSearch; period: Period; today: string }) {
  const { t } = useTranslation();
  const presets: Preset[] = ['month', 'lastMonth', 'three', 'twelve', 'year'];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('insights.period.label')}>
      {presets.map((p) => {
        const pp = presetPeriod(p, today);
        const active = pp.from === period.from && pp.to === period.to;
        return (
          <Link
            key={p}
            to="/insights/$area"
            params={{ area }}
            search={clean({ ...search, from: pp.from, to: pp.to })}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-[13px]',
              active ? 'accent-pill border-transparent text-text' : 'border-line-2 text-muted hover:text-text',
            )}
          >
            {t(`insights.period.${p}`)}
          </Link>
        );
      })}
    </div>
  );
}

/** "Spend › Grocery › Rice › Keeri samba" — every step is a link back up. */
export function Crumbs({
  area,
  search,
  labels,
  period,
  locale,
}: {
  area: Area;
  search: InsightsSearch;
  labels: Partial<Record<string, string>>;
  period: Period;
  locale: string;
}) {
  const { t } = useTranslation();
  const list = crumbs(search);
  const when =
    period.from === period.to
      ? formatMonth(period.from, locale)
      : `${formatMonth(period.from, locale)} – ${formatMonth(period.to, locale)}`;
  return (
    <nav aria-label={t('insights.path')} className="flex flex-wrap items-center gap-1 text-[13.5px]">
      {list.map((c, i) => {
        const last = i === list.length - 1;
        const label = c.key === 'area' ? t(`insights.areas.${area}.title`) : (labels[c.key] ?? t('insights.none'));
        return (
          <span key={c.key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-faint" aria-hidden />}
            {last ? (
              <span aria-current="page" className="font-medium">
                {label}
              </span>
            ) : (
              <Link to="/insights/$area" params={{ area }} search={clean(c.search)} className="text-accent-b hover:underline">
                {label}
              </Link>
            )}
          </span>
        );
      })}
      <span className="tabular ml-2 text-[12.5px] text-faint">{when}</span>
    </nav>
  );
}
