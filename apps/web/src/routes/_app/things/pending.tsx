import { useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, PackageCheck, Plus, Receipt } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/aurora/EmptyState';
import { Money } from '@/components/money/bits';
import { AssetForm, initialFromLine } from '@/components/things/AssetForm';
import { useThings } from '@/components/things/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { invalidateThings, markNotThings, thingsErrorKey, type PendingLine } from '@/lib/things/queries';
import { formatDay } from '@/lib/time';
import { UNDO_MS } from '@/lib/undo';

export const Route = createFileRoute('/_app/things/pending')({
  component: PendingPage,
});

/** "Bought, not entered yet": Things lines of bills that no thing points at (decision 2026-09-25). */
function PendingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const things = useThings(householdId);
  const [entering, setEntering] = useState<PendingLine | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => things.pending.data ?? [], [things.pending.data]);

  const bills = useMemo(() => {
    const map = new Map<string, PendingLine[]>();
    for (const l of lines) {
      const key = l.transaction_id ?? '';
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return [...map.values()];
  }, [lines]);

  async function notThings(rows: PendingLine[]) {
    setBusy(true);
    try {
      await markNotThings(rows);
      await invalidateThings(qc, householdId);
      toast.success(t('things.pending.notThings', { count: rows.length }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            markNotThings(rows, 'asset')
              .then(() => invalidateThings(qc, householdId))
              .catch((e: unknown) => toast.error(t(`things.errors.${thingsErrorKey(e)}`)));
          },
        },
      });
    } catch (e) {
      toast.error(t(`things.errors.${thingsErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/things" className="-mb-2 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.things')}
      </Link>
      <div>
        <h1 className="font-display text-[28px] font-semibold tracking-tight">{t('things.pending.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('things.pending.intro')}</p>
      </div>

      {things.pending.isPending ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : lines.length === 0 ? (
        <EmptyState icon={PackageCheck} title={t('things.pending.emptyTitle')} body={t('things.pending.emptyBody')} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="pending-list">
          {bills.map((rows) => {
            const first = rows[0]!;
            return (
              <Card key={first.transaction_id} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <Receipt className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
                  <Link
                    to="/money/tx/$txId"
                    params={{ txId: first.transaction_id ?? '' }}
                    className="min-w-0 flex-1 truncate text-[14px] text-accent-b"
                  >
                    {first.payee_text ?? t('things.form.aShop')} · {first.occurred_on ? formatDay(first.occurred_on, locale) : ''}
                  </Link>
                  {canWrite && rows.length > 1 && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void notThings(rows)}>
                      {t('things.pending.noneOfThese')}
                    </Button>
                  )}
                </div>
                <ul className="flex flex-col gap-2">
                  {rows.map((l) => (
                    <li key={l.line_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-white/[0.03] px-3.5 py-3" data-testid="pending-line">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px]">{l.raw_name}</div>
                        <div className="text-[12.5px] text-muted">
                          {l.category_name ?? '—'}
                          {l.qty && Number(l.qty) !== 1 ? ` · ×${Number(l.qty)}` : ''}
                        </div>
                      </div>
                      <Money value={Number(l.amount ?? 0)} className="text-[15px]" />
                      {canWrite && (
                        <div className="flex w-full gap-1.5 sm:w-auto">
                          <Button size="sm" variant="accent" className="flex-1 sm:flex-none" onClick={() => setEntering(l)}>
                            <Plus className="h-4 w-4" aria-hidden />
                            {t('things.pending.add')}
                          </Button>
                          <Button size="sm" className="flex-1 sm:flex-none" disabled={busy} onClick={() => void notThings([l])}>
                            {t('things.pending.notAThing')}
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}

      {things.categories.data && (
        <AssetForm
          open={Boolean(entering)}
          onClose={() => setEntering(null)}
          householdId={householdId}
          locale={locale}
          categories={things.categories.data}
          tree={things.tree}
          assets={things.assets.data ?? []}
          tags={things.tags.data ?? []}
          fields={things.fields.data ?? []}
          initial={entering ? initialFromLine(entering) : null}
          onSaved={(id) => void navigate({ to: '/things/$assetId', params: { assetId: id } })}
        />
      )}
    </div>
  );
}
