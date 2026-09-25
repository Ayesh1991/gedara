import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Num } from '@/components/insights/Num';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { spendFilter } from '@/lib/insights/drill';
import { budgetMonthQuery, invalidateInsights, setBudget, spendGroupsQuery } from '@/lib/insights/queries';
import { formatLKR, parseAmount } from '@/lib/money/format';
import { categoriesQuery, invalidateMoney } from '@/lib/money/queries';
import { monthParam } from '@/lib/search';
import { addMonths, formatMonth, todayIn } from '@/lib/time';

const SearchSchema = z.object({ month: monthParam().optional() });

export const Route = createFileRoute('/_app/money/budgets')({
  validateSearch: SearchSchema,
  component: BudgetsPage,
});

/** Monthly budgets per main category (Didula, 2026-09-25): set once, they carry over until changed. */
function BudgetsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const thisMonth = todayIn(timezone).slice(0, 7);
  const month = Route.useSearch().month ?? thisMonth;
  const categories = useQuery(categoriesQuery(householdId));
  const status = useQuery(budgetMonthQuery(householdId, month));
  // "Usual" = the average of the three months before this one.
  const avg = useQuery(
    spendGroupsQuery(householdId, spendFilter({}, { from: addMonths(month, -3), to: addMonths(month, -1) }), 'top'),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const tops = (categories.data ?? []).filter((c) => c.parent_id === null && !c.archived && c.kind !== 'income');
  const byCat = new Map((status.data ?? []).map((b) => [b.category_id, b]));
  const usual = new Map((avg.data ?? []).map((g) => [g.key, g.amount / 3]));
  const total = (status.data ?? []).reduce((s, b) => s + (b.budget ?? 0), 0);
  const spent = (status.data ?? []).filter((b) => b.budget !== null).reduce((s, b) => s + b.spent, 0);

  async function save(categoryId: string, text: string) {
    const amount = text.trim() === '' ? 0 : parseAmount(text);
    if (amount === null || amount < 0) {
      toast.error(t('budgets.invalid'));
      return;
    }
    if ((byCat.get(categoryId)?.budget ?? 0) === amount) return;
    setSaving(categoryId);
    try {
      await setBudget(householdId, categoryId, month, amount);
      await Promise.all([invalidateMoney(qc, householdId), invalidateInsights(qc, householdId)]);
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== categoryId)));
      toast.success(amount > 0 ? t('budgets.saved', { month: formatMonth(month, locale) }) : t('budgets.cleared', { month: formatMonth(month, locale) }));
    } catch {
      toast.error(t('budgets.error'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/money" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.money')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('budgets.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('budgets.intro')}</p>
      </div>

      <div className="flex items-center gap-2">
        <Link to="/money/budgets" search={{ month: addMonths(month, -1) }} aria-label={t('budgets.prev')} className="glass flex h-10 w-10 items-center justify-center rounded-xl">
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
        <span className="min-w-40 text-center font-display text-[17px] font-semibold">{formatMonth(month, locale)}</span>
        <Link to="/money/budgets" search={{ month: addMonths(month, 1) }} aria-label={t('budgets.next')} className="glass flex h-10 w-10 items-center justify-center rounded-xl">
          <ChevronRight className="h-5 w-5" aria-hidden />
        </Link>
        {total > 0 && (
          <span className="tabular ml-auto text-[13.5px] text-muted">
            {t('budgets.totals', { spent: formatLKR(spent, { whole: true }), budget: formatLKR(total, { whole: true }) })}
          </span>
        )}
      </div>

      {status.isError ? (
        <Card className="text-[14px] text-red">{t('budgets.error')}</Card>
      ) : !status.data || !categories.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-line">
            {tops.map((c) => {
              const b = byCat.get(c.id);
              const current = b?.budget ?? null;
              const draft = drafts[c.id] ?? (current !== null ? String(current) : '');
              const typical = usual.get(c.id);
              const inherited = current !== null && b?.budget_from && b.budget_from.slice(0, 7) !== month;
              return (
                <li key={c.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[15px]">
                      <span aria-hidden>{c.icon}</span>
                      <span className="truncate">{c.name}</span>
                    </div>
                    <div className="tabular text-[12.5px] text-muted">
                      {t('budgets.spent')}{' '}
                      <Num value={b?.spent ?? 0} whole to={{ to: '/insights/$area', params: { area: 'spend' }, search: { cat: c.id, from: month, to: month } }} />
                      {typical !== undefined && typical > 0 && <> · {t('budgets.usual', { amount: formatLKR(typical, { whole: true }) })}</>}
                      {inherited && <> · {t('budgets.since', { month: formatMonth(b!.budget_from!.slice(0, 7), locale) })}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canWrite && typical !== undefined && typical > 0 && current === null && (
                      <button
                        type="button"
                        className="rounded-lg px-2 py-1 text-[12.5px] text-accent-b hover:bg-white/5"
                        onClick={() => void save(c.id, String(Math.ceil(typical / 100) * 100))}
                      >
                        {t('budgets.useUsual')}
                      </button>
                    )}
                    <Input
                      inputMode="decimal"
                      aria-label={t('budgets.amountFor', { name: c.name })}
                      placeholder={t('budgets.none')}
                      disabled={!canWrite || saving === c.id}
                      value={draft}
                      onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      onBlur={(e) => void save(c.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className="tabular h-11 w-36 text-right"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <p className="text-[12.5px] text-faint">{t('budgets.carryHint')}</p>
    </div>
  );
}
