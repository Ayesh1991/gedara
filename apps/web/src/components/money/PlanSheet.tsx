import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { deletePlan, plansQuery, savePlan, type Plan } from '@/lib/money/instalmentQueries';
import { firstFromCurrent, instalmentDate, loanInstalment, paidCount } from '@/lib/money/instalments';
import { formatLKR, parseAmount } from '@/lib/money/format';
import type { Account } from '@/lib/money/queries';
import { cn } from '@/lib/utils';
import { AccountSelect, fieldLabel } from './bits';

export interface PlanDraft {
  kind: 'card' | 'loan';
  account_id: string | null;
  name: string;
  monthly: string;
  total: string;
  current: string;
  currentOn: string;
  principal: string;
  rate: string;
  source_sms_id: string | null;
}

export function draftFrom(plan: Plan | null, today: string): PlanDraft {
  if (!plan) {
    return { kind: 'card', account_id: null, name: '', monthly: '', total: '', current: '1', currentOn: today, principal: '', rate: '', source_sms_id: null };
  }
  const paid = Math.max(1, Math.min(plan.total_count, paidCount(plan, today)));
  return {
    kind: plan.kind,
    account_id: plan.account_id,
    name: plan.name,
    monthly: String(plan.monthly),
    total: String(plan.total_count),
    current: String(paid),
    currentOn: instalmentDate(plan.first_on, paid),
    principal: plan.principal == null ? '' : String(plan.principal),
    rate: plan.annual_rate == null ? '' : String(plan.annual_rate),
    source_sms_id: plan.source_sms_id,
  };
}

/**
 * Add or change an instalment plan (9b.2). A statement line says "Toyota Lanka <7/12> 09/10/2026 6,470.72":
 * the monthly amount, which instalment it was, of how many, and its date — the first date follows.
 */
export function PlanSheet({
  open,
  plan,
  draft,
  householdId,
  accounts,
  today,
  onClose,
}: {
  open: boolean;
  plan: Plan | null;
  draft: PlanDraft | null;
  householdId: string;
  accounts: Account[];
  today: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // (the page mounts a fresh sheet — a new key — each time it opens, so the form starts from these props)
  const [d, setD] = useState<PlanDraft>(() => draft ?? draftFrom(plan, today));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PlanDraft>) => setD((x) => ({ ...x, ...patch }));

  const pickable = accounts.filter((a) => !a.archived && !a.is_suspense && (d.kind === 'loan' ? a.kind === 'loan' : a.kind === 'credit_card'));
  const monthly = parseAmount(d.monthly);
  const total = Number(d.total);
  const current = Number(d.current);
  const principal = d.kind === 'loan' ? parseAmount(d.principal) : null;
  const rate = d.kind === 'loan' && d.rate.trim() ? Number(d.rate) : null;
  const valid =
    !!d.account_id && d.name.trim().length > 0 && monthly !== null && monthly > 0 &&
    Number.isInteger(total) && total >= 1 && total <= 600 && Number.isInteger(current) && current >= 1 && current <= total &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.currentOn) &&
    (d.kind === 'card' || (principal !== null && principal > 0 && rate !== null && rate >= 0 && rate < 100));
  const bankWould = d.kind === 'loan' && principal && rate !== null && total >= 1 ? loanInstalment(principal, rate, total) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await savePlan(householdId, {
        account_id: d.account_id!,
        kind: d.kind,
        name: d.name.trim(),
        monthly: monthly!,
        total_count: total,
        first_on: firstFromCurrent(d.currentOn, current),
        principal: d.kind === 'loan' ? principal : null,
        annual_rate: d.kind === 'loan' ? rate : null,
        source_sms_id: d.source_sms_id,
      }, plan?.id);
      await qc.invalidateQueries({ queryKey: plansQuery(householdId).queryKey });
      toast.success(t('instalments.saved'));
      onClose();
    } catch {
      toast.error(t('instalments.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan || busy || !window.confirm(t('instalments.confirmDelete', { name: plan.name }))) return;
    setBusy(true);
    try {
      await deletePlan(plan.id);
      await qc.invalidateQueries({ queryKey: plansQuery(householdId).queryKey });
      toast.success(t('instalments.deleted'));
      onClose();
    } catch {
      toast.error(t('instalments.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t(plan ? 'instalments.editTitle' : 'instalments.addTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div role="tablist" aria-label={t('instalments.kindLabel')} className="grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
          {(['card', 'loan'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={d.kind === k}
              onClick={() => set({ kind: k, account_id: null })}
              className={cn('h-10 rounded-xl font-display text-[14.5px] font-medium text-muted transition-colors', d.kind === k && 'accent-pill text-text')}
            >
              {t(`instalments.kind.${k}`)}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="plan-account" className={fieldLabel}>{t(d.kind === 'loan' ? 'instalments.loanAccount' : 'instalments.card')}</label>
          <AccountSelect id="plan-account" accounts={pickable} value={d.account_id} onChange={(id) => set({ account_id: id })} />
          {pickable.length === 0 && <p className="mt-1.5 text-[12.5px] text-caution">{t(d.kind === 'loan' ? 'instalments.noLoan' : 'instalments.noCard')}</p>}
        </div>
        <div>
          <label htmlFor="plan-name" className={fieldLabel}>{t('instalments.name')}</label>
          <Input id="plan-name" value={d.name} maxLength={80} placeholder={t('instalments.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="plan-monthly" className={fieldLabel}>{t('instalments.monthly')}</label>
            <Input id="plan-monthly" inputMode="decimal" className="tabular" value={d.monthly} onChange={(e) => set({ monthly: e.target.value })} />
          </div>
          <div>
            <label htmlFor="plan-total" className={fieldLabel}>{t('instalments.total')}</label>
            <Input id="plan-total" inputMode="numeric" className="tabular" value={d.total} onChange={(e) => set({ total: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="plan-current" className={fieldLabel}>{t('instalments.current')}</label>
            <Input id="plan-current" inputMode="numeric" className="tabular" value={d.current} onChange={(e) => set({ current: e.target.value })} />
          </div>
          <div>
            <label htmlFor="plan-on" className={fieldLabel}>{t('instalments.currentOn')}</label>
            <Input id="plan-on" type="date" value={d.currentOn} onChange={(e) => set({ currentOn: e.target.value })} />
          </div>
        </div>
        <p className="text-[12.5px] text-muted">{t('instalments.statementHint')}</p>
        {d.kind === 'loan' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="plan-principal" className={fieldLabel}>{t('instalments.principal')}</label>
                <Input id="plan-principal" inputMode="decimal" className="tabular" value={d.principal} onChange={(e) => set({ principal: e.target.value })} />
              </div>
              <div>
                <label htmlFor="plan-rate" className={fieldLabel}>{t('instalments.rate')}</label>
                <Input id="plan-rate" inputMode="decimal" className="tabular" value={d.rate} onChange={(e) => set({ rate: e.target.value })} />
              </div>
            </div>
            {bankWould !== null && (
              <p className={cn('tabular text-[12.5px]', monthly !== null && Math.abs(bankWould - monthly) < 1 ? 'text-teal' : 'text-muted')}>
                {t('instalments.bankWould', { amount: formatLKR(bankWould) })}
              </p>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" className="flex-1" disabled={!valid || busy}>
            {t('instalments.save')}
          </Button>
          {plan && (
            <Button type="button" variant="ghost" className="text-red" disabled={busy} onClick={() => void remove()}>
              {t('instalments.delete')}
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
