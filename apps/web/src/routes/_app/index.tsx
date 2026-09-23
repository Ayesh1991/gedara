import { createFileRoute } from '@tanstack/react-router';
import { CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Ring, Sparkline, smoothPath } from '@/components/aurora/charts';
import { StatTile } from '@/components/aurora/StatTile';
import { Card } from '@/components/ui/card';
import { dayPart, firstName, hourIn } from '@/lib/time';

export const Route = createFileRoute('/_app/')({
  component: Pulse,
});

// Ghost shapes for empty states: they show where data will appear, never pretend to be data.
const GHOST_TREND = [3, 4, 3.6, 5, 4.6, 6];
const GHOST_IN = [70, 72, 71, 80, 78, 74];
const GHOST_OUT = [50, 58, 46, 64, 55, 48];
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

function AwaitingChip({ phase }: { phase: number }) {
  const { t } = useTranslation();
  return (
    <span className="tabular whitespace-nowrap rounded-full bg-white/5 px-2 py-0.5 text-[10.5px] text-muted sm:text-[11px]">
      {t('home.awaiting', { phase })}
    </span>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{children}</p>;
}

function Pulse() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  const part = dayPart(hourIn(membership.household.timezone));
  const name = firstName(membership.displayName, membership.email);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight lg:text-[32px]">
        {t(`home.greeting.${part}`, { name })}
      </h1>

      <section aria-label={t('home.net')} className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatTile
          highlight
          empty
          label={t('home.net')}
          value="Rs —"
          footer={<AwaitingChip phase={2} />}
          side={<Sparkline values={GHOST_TREND} width={88} height={30} ghost />}
        />
        <StatTile
          empty
          label={t('home.spent')}
          value="Rs —"
          footer={<AwaitingChip phase={2} />}
          side={<Ring value={0} size={60} label={t('home.budget')} />}
        />
        <StatTile empty label={t('home.pantryValue')} value="Rs —" footer={<AwaitingChip phase={3} />} />
        <StatTile empty label={t('home.things')} value="—" footer={<AwaitingChip phase={5} />} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <h2 className="flex-1 font-display text-[17px] font-semibold">{t('home.cashFlow')}</h2>
            <span className="flex items-center gap-1.5 text-[12.5px] text-[#a5b0d0]">
              <span className="h-2 w-2 rounded-full bg-accent-b" />
              {t('home.income')}
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-[#a5b0d0]">
              <span className="h-2 w-2 rounded-full bg-accent-a" />
              {t('home.outgoing')}
            </span>
          </div>
          <div className="relative">
            <svg width="100%" height="170" viewBox="0 0 700 170" preserveAspectRatio="none" aria-hidden>
              <path
                d="M0 30H700M0 85H700M0 140H700"
                style={{ stroke: 'var(--line)' }}
                strokeDasharray="3 6"
                fill="none"
              />
              <path
                d={smoothPath(GHOST_IN, 700, 150, 20)}
                fill="none"
                strokeWidth={2}
                strokeDasharray="4 7"
                vectorEffect="non-scaling-stroke"
                style={{ stroke: 'color-mix(in srgb, var(--accent-b) 45%, transparent)' }}
              />
              <path
                d={smoothPath(GHOST_OUT, 700, 150, 20)}
                fill="none"
                strokeWidth={2}
                strokeDasharray="4 7"
                vectorEffect="non-scaling-stroke"
                style={{ stroke: 'color-mix(in srgb, var(--accent-a) 45%, transparent)' }}
                transform="translate(0 16)"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <div className="glass-strong max-w-sm rounded-2xl px-4 py-3">
                <EmptyNote>{t('home.cashFlowEmpty')}</EmptyNote>
              </div>
            </div>
          </div>
          <div className="tabular flex justify-between text-[11.5px] text-faint">
            {MONTHS.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="font-display text-[17px] font-semibold">{t('home.budget')}</h2>
          <div className="flex flex-col gap-3.5" aria-hidden>
            {[72, 48, 88, 36].map((w) => (
              <div key={w} className="flex flex-col gap-2">
                <div className="h-2.5 w-24 rounded-full bg-white/[0.06]" />
                <div className="h-2 rounded-full bg-white/[0.06]">
                  <div
                    className="h-2 rounded-full opacity-30"
                    style={{ width: `${w}%`, background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))' }}
                  />
                </div>
              </div>
            ))}
          </div>
          <EmptyNote>{t('home.budgetEmpty')}</EmptyNote>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <h2 className="font-display text-[17px] font-semibold">{t('home.attention')}</h2>
          <div className="flex items-center gap-3 rounded-2xl bg-teal/[0.07] px-3.5 py-3">
            <CircleCheck className="h-5 w-5 shrink-0 text-teal" aria-hidden />
            <EmptyNote>{t('home.attentionEmpty')}</EmptyNote>
          </div>
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[17px] font-semibold">{t('home.activity')}</h2>
            <span className="tabular flex items-center gap-1.5 text-[11px] text-teal">
              <span className="h-[7px] w-[7px] rounded-full bg-teal shadow-[0_0_10px_var(--teal)]" />
              {t('home.live')}
            </span>
          </div>
          <div className="flex gap-3.5">
            <div className="flex flex-col items-center pt-1" aria-hidden>
              <span className="h-3 w-3 rounded-full border-2 border-accent-b" />
              <span className="w-0.5 flex-1 bg-gradient-to-b from-[var(--accent-b)] to-transparent opacity-50" />
            </div>
            <EmptyNote>{t('home.activityEmpty')}</EmptyNote>
          </div>
        </Card>
      </section>
    </div>
  );
}
