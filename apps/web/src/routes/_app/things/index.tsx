import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Package, Plus, Printer, Receipt, Search } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { EmptyState } from '@/components/aurora/EmptyState';
import { StatTile } from '@/components/aurora/StatTile';
import { Money } from '@/components/money/bits';
import { AssetForm } from '@/components/things/AssetForm';
import { AssetCard } from '@/components/things/AssetViews';
import { useThings } from '@/components/things/bits';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Asset } from '@/lib/things/queries';
import { SERVICE_SOON_DAYS, WARRANTY_SOON_DAYS, daysBetween, warrantyState } from '@/lib/things/value';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';
import { textParam } from '@/lib/search';

const FILTERS = ['active', 'attention', 'lent', 'in_repair', 'stored', 'gone', 'all'] as const;
type Filter = (typeof FILTERS)[number];

// The router JSON-parses search values that look like numbers ("A-0042" doesn't, "42" does): accept both.
const text = textParam;

const SearchSchema = z.object({
  q: text(80).optional(),
  filter: z.enum(FILTERS).optional(),
  tag: z.string().uuid().optional(),
  /** Open "New thing" (`?new=1` arrives as the number 1 from a typed URL). */
  new: z.union([z.string(), z.number()]).transform(String).pipe(z.literal('1')).optional(),
});

export const Route = createFileRoute('/_app/things/')({
  validateSearch: SearchSchema,
  component: ThingsPage,
});

const GONE = new Set(['sold', 'disposed', 'lost']);

/** Warranty ending soon or a service due soon (the "Attention" of Things). */
function needsAttention(a: Asset, today: string): boolean {
  if (GONE.has(a.status)) return false;
  if (warrantyState(a, today).state === 'ending') return true;
  return a.next_due !== null && daysBetween(today, a.next_due) <= SERVICE_SOON_DAYS;
}

function matches(a: Asset, filter: Filter, today: string): boolean {
  switch (filter) {
    case 'active':
      return !GONE.has(a.status);
    case 'attention':
      return needsAttention(a, today);
    case 'gone':
      return GONE.has(a.status);
    case 'all':
      return true;
    default:
      return a.status === filter;
  }
}

function ThingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: '/things/' });
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const things = useThings(householdId);
  const createdRef = useRef<string | null>(null);
  const filter: Filter = search.filter ?? 'active';

  const setSearch = (patch: Partial<z.infer<typeof SearchSchema>>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const assets = useMemo(() => things.assets.data ?? [], [things.assets.data]);
  const pending = things.pending.data ?? [];
  const owned = assets.filter((a) => !GONE.has(a.status));
  const cost = owned.reduce((s, a) => s + (a.purchase_price ?? 0), 0);
  const value = owned.reduce((s, a) => s + (a.current_value ?? 0), 0);
  const unpriced = owned.filter((a) => a.purchase_price === null).length;
  const attention = owned.filter((a) => needsAttention(a, today)).length;
  const warrantiesEnding = owned.filter((a) => warrantyState(a, today).state === 'ending').length;

  const shown = useMemo(() => {
    const q = search.q?.trim().toLowerCase();
    return assets
      .filter((a) => matches(a, filter, today))
      .filter((a) => !search.tag || a.tag_ids.includes(search.tag))
      .filter(
        (a) =>
          !q ||
          [a.name, a.tag, a.code, a.manufacturer, a.model_no, a.serial_no, a.location_path, ...a.tag_names]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(q)),
      );
  }, [assets, filter, search.tag, search.q, today]);

  const usedTags = (things.tags.data ?? []).filter((tag) => assets.some((a) => a.tag_ids.includes(tag.id)));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('nav.things')}</h1>
          <p className="mt-1 text-[14.5px] text-muted">{t('things.intro')}</p>
        </div>
        <div className="flex gap-2.5">
          {shown.length > 0 && (
            <Link
              to="/places/labels"
              search={{ assets: shown.map((a) => a.id).join(',') }}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              <Printer className="h-4 w-4" aria-hidden />
              {t('things.labels')}
            </Link>
          )}
          {canWrite && (
            <Button variant="primary" size="sm" onClick={() => setSearch({ new: '1' })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('things.add')}
            </Button>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <Link
          to="/things/pending"
          className="glass flex items-center gap-3.5 rounded-[var(--r)] p-4 transition-colors hover:bg-white/[0.04]"
          data-testid="pending-strip"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-info/15 text-info">
            <Receipt className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[16px] font-semibold">{t('things.pending.strip', { count: pending.length })}</span>
            <span className="block truncate text-[13px] text-muted">
              {pending
                .slice(0, 3)
                .map((p) => p.raw_name)
                .join(' · ')}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 text-muted" aria-hidden />
        </Link>
      )}

      {things.error ? (
        <Card className="text-[14px] text-red">{t('things.loadError')}</Card>
      ) : !things.ready ? (
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass aspect-[3/4] animate-pulse rounded-[var(--r)]" />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t('things.emptyTitle')}
          body={t('things.emptyBody')}
          action={
            canWrite ? (
              <Button variant="accent" onClick={() => setSearch({ new: '1' })}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('things.addFirst')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section aria-label={t('things.summary')} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4">
            <StatTile
              label={t('things.stats.owned')}
              value={<span className="tabular text-[21px] lg:text-[24px]">{owned.length}</span>}
              footer={
                unpriced > 0 ? (
                  t('things.stats.unpriced', { count: unpriced })
                ) : (
                  <span>
                    {t('things.stats.paid')} <Money value={cost} whole />
                  </span>
                )
              }
            />
            <StatTile
              label={t('things.stats.value')}
              value={<Money value={value} whole className="text-[19px] sm:text-[21px] lg:text-[24px]" />}
              empty={value === 0}
              footer={t('things.stats.valueHint')}
            />
            <div className="col-span-2 sm:col-span-1">
              <StatTile
                highlight={attention > 0}
                label={t('things.stats.attention')}
                value={<span className="tabular text-[21px] lg:text-[24px]">{attention}</span>}
                footer={
                  attention > 0 ? (
                    <button type="button" className="text-accent-b underline" onClick={() => setSearch({ filter: 'attention' })}>
                      {warrantiesEnding > 0
                        ? t('things.stats.warrantiesEnding', { count: warrantiesEnding, days: WARRANTY_SOON_DAYS })
                        : t('things.stats.show')}
                    </button>
                  ) : (
                    t('things.stats.allGood')
                  )
                }
              />
            </div>
          </section>

          <div className="flex flex-col gap-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                type="search"
                aria-label={t('things.search')}
                placeholder={t('things.search')}
                className="pl-10"
                value={search.q ?? ''}
                onChange={(e) => setSearch({ q: e.target.value || undefined })}
              />
            </div>
            <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0" role="group" aria-label={t('things.filterLabel')}>
              <div className="flex gap-1.5 pb-1">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setSearch({ filter: f === 'active' ? undefined : f })}
                    className={cn(
                      'h-9 shrink-0 rounded-full border px-3.5 text-[13px] whitespace-nowrap',
                      filter === f ? 'accent-pill border-transparent text-text' : 'border-line-2 text-muted',
                    )}
                  >
                    {t(`things.filters.${f}`)}
                  </button>
                ))}
                {usedTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={search.tag === tag.id}
                    onClick={() => setSearch({ tag: search.tag === tag.id ? undefined : tag.id })}
                    className={cn(
                      'h-9 shrink-0 rounded-full border px-3.5 text-[13px] whitespace-nowrap',
                      search.tag === tag.id ? 'accent-pill border-transparent text-text' : 'border-dashed border-line-2 text-muted',
                    )}
                  >
                    #{tag.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <Card className="text-center text-[14.5px] text-muted">{t('things.noMatches')}</Card>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4" data-testid="asset-grid">
              {shown.map((a) => (
                <AssetCard key={a.id} asset={a} photo={things.photos.data?.get(a.id)} today={today} />
              ))}
            </div>
          )}
        </>
      )}

      {things.categories.data && (
        <AssetForm
          open={Boolean(search.new)}
          onClose={() => {
            // A new thing opens its page (to add receipts and a service plan); otherwise just close.
            const created = createdRef.current;
            createdRef.current = null;
            if (created) void navigate({ to: '/things/$assetId', params: { assetId: created } });
            else setSearch({ new: undefined });
          }}
          householdId={householdId}
          locale={locale}
          categories={things.categories.data}
          tree={things.tree}
          assets={assets}
          tags={things.tags.data ?? []}
          fields={things.fields.data ?? []}
          onSaved={(id) => {
            createdRef.current = id;
          }}
        />
      )}
    </div>
  );
}
