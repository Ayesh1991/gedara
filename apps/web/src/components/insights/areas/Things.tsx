import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarList, Figure } from '@/components/insights/charts';
import { Num, TargetLink } from '@/components/insights/Num';
import { assetsQuery } from '@/lib/things/queries';
import { formatDay } from '@/lib/time';
import type { AreaProps } from '.';
import { Empty, LoadError, Loading, Section, lkr } from './common';

const GONE = new Set(['sold', 'disposed', 'lost']);

/** Things: what they cost vs what they're worth, insured or not, cost per month, warranty and service calendars. */
export function ThingsArea({ membership, today }: AreaProps) {
  const { t } = useTranslation();
  const { id: householdId, locale } = membership.household;
  const assets = useQuery(assetsQuery(householdId));
  if (assets.isError) return <LoadError />;
  if (!assets.data) return <Loading />;

  const owned = assets.data.filter((a) => !GONE.has(a.status));
  if (owned.length === 0) {
    return (
      <Section title={t('insights.areas.things.title')}>
        <Empty>{t('insights.things.empty')}</Empty>
      </Section>
    );
  }
  const cost = owned.reduce((s, a) => s + (a.purchase_price ?? 0), 0);
  const value = owned.reduce((s, a) => s + (a.current_value ?? 0), 0);
  const insured = owned.filter((a) => a.insured).reduce((s, a) => s + (a.current_value ?? 0), 0);
  const assetTo = (id: string) => ({ to: '/things/$assetId', params: { assetId: id } });
  const warranties = owned
    .filter((a) => !a.lifetime_warranty && a.warranty_until && a.warranty_until >= today)
    .sort((a, b) => (a.warranty_until ?? '').localeCompare(b.warranty_until ?? ''));
  const services = owned.filter((a) => a.next_due).sort((a, b) => (a.next_due ?? '').localeCompare(b.next_due ?? ''));

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('insights.things.value')}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label={t('insights.things.cost')}>
            <Num value={cost} whole to={{ to: '/things' }} />
          </Figure>
          <Figure label={t('insights.things.now')} hint={t('insights.things.nowHint')}>
            <Num value={value} whole to={{ to: '/things' }} />
          </Figure>
          <Figure label={t('insights.things.insured')}>
            <Num value={insured} whole to={{ to: '/things' }} />
          </Figure>
          <Figure label={t('insights.things.uninsured')}>
            <Num value={value - insured} whole to={{ to: '/things' }} />
          </Figure>
        </div>
        <BarList
          label={t('insights.things.value')}
          format={lkr}
          rows={owned
            .filter((a) => (a.current_value ?? 0) > 0)
            .sort((a, b) => (b.current_value ?? 0) - (a.current_value ?? 0))
            .map((a) => ({
              key: a.id,
              label: a.name,
              sub: [a.tag, a.insured ? t('insights.things.insuredTag') : null].filter(Boolean).join(' · '),
              value: a.current_value ?? 0,
              ghost: a.purchase_price ?? undefined,
              to: assetTo(a.id),
            }))}
        />
      </Section>

      <Section title={t('insights.things.perMonth')}>
        {owned.some((a) => a.cost_per_month !== null) ? (
          <BarList
            label={t('insights.things.perMonth')}
            format={lkr}
            rows={owned
              .filter((a) => a.cost_per_month !== null)
              .sort((a, b) => (b.cost_per_month ?? 0) - (a.cost_per_month ?? 0))
              .map((a) => ({
                key: a.id,
                label: a.name,
                sub: t('insights.things.months', { count: a.months_owned ?? 0 }),
                value: a.cost_per_month ?? 0,
                to: assetTo(a.id),
              }))}
          />
        ) : (
          <Empty>{t('insights.things.noPrices')}</Empty>
        )}
      </Section>

      <Section title={t('insights.things.warranties')}>
        {warranties.length === 0 ? (
          <Empty>{t('insights.things.noWarranties')}</Empty>
        ) : (
          <BarList
            label={t('insights.things.warranties')}
            format={(v) => t('insights.pantry.days', { count: v })}
            rows={warranties.map((a) => ({
              key: a.id,
              label: a.name,
              sub: formatDay(a.warranty_until!, locale, today.slice(0, 4)),
              value: a.warranty_days_left ?? 0,
              tone: (a.warranty_days_left ?? 99) <= 30 ? 'caution' : 'default',
              to: assetTo(a.id),
            }))}
          />
        )}
      </Section>

      <Section title={t('insights.things.services')}>
        {services.length === 0 ? (
          <Empty>{t('insights.things.noServices')}</Empty>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {services.map((a) => (
              <li key={a.id}>
                <TargetLink target={assetTo(a.id)} className="flex gap-3 rounded-xl px-2 py-2.5 text-[14.5px] hover:bg-white/[0.04]">
                  <span className="tabular w-28 shrink-0 text-muted">{formatDay(a.next_due!, locale, today.slice(0, 4))}</span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </TargetLink>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
