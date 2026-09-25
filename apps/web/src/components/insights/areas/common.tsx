import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import type { Target } from '@/lib/attention';
import { clean, type Area, type InsightsSearch } from '@/lib/insights/drill';
import { formatLKR } from '@/lib/money/format';

export const lkr = (v: number) => formatLKR(v, { whole: true });
export const lkr2 = (v: number) => formatLKR(v);
export const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} %`;

/** A link to an Insights view. */
export function areaTo(area: Area, search: InsightsSearch): Target {
  return { to: '/insights/$area', params: { area }, search: clean(search) };
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-[17px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function Loading() {
  return <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />;
}

export function LoadError() {
  const { t } = useTranslation();
  return <Card className="text-[14px] text-red">{t('insights.loadError')}</Card>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{children}</p>;
}
