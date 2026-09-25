import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AccountSelect, CategorySelect, Money } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { findSub, type CategoryRow } from '@/lib/money/categoriesMap';
import { lineFingerprint, manualFingerprint } from '@/lib/money/fingerprint';
import { parseAmount } from '@/lib/money/format';
import { lastAccount, pickableAccounts, rememberAccount, type Account } from '@/lib/money/queries';
import {
  deleteLog,
  deletePlan,
  invalidateThings,
  logMaintenance,
  recentExpensesQuery,
  savePlan,
  thingsErrorKey,
  type Asset,
  type Plan,
} from '@/lib/things/queries';
import { addDaysIso, daysBetween } from '@/lib/things/value';
import { formatDay, todayIn } from '@/lib/time';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { fieldLabel, selectClass, textareaClass } from './bits';

type MoneyMode = 'new' | 'link' | 'none';

/** The expense category for a service: the plan's, else Services › Repairs & maintenance. */
export function repairsCategory(categories: CategoryRow[], plan?: Pick<Plan, 'category_id'> | null): string | null {
  return plan?.category_id ?? findSub(categories, 'services', 'Repairs & maintenance')?.id ?? null;
}

/** Log a service / repair (§4 row 5): a cost becomes a ledger expense, or is linked to one already there. */
export function LogServiceSheet({
  open,
  onClose,
  householdId,
  timezone,
  locale,
  asset,
  plans,
  planId,
  accounts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  locale: string;
  asset: Asset;
  plans: Plan[];
  planId?: string | null;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t('maintenance.log.title', { name: asset.name })}>
      {open && (
        <LogServiceBody
          onClose={onClose}
          householdId={householdId}
          timezone={timezone}
          locale={locale}
          asset={asset}
          plans={plans}
          planId={planId}
          accounts={accounts}
          categories={categories}
        />
      )}
    </Sheet>
  );
}

function LogServiceBody({
  onClose,
  householdId,
  timezone,
  locale,
  asset,
  plans,
  planId,
  accounts,
  categories,
}: {
  onClose: () => void;
  householdId: string;
  timezone: string;
  locale: string;
  asset: Asset;
  plans: Plan[];
  planId?: string | null;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const today = todayIn(timezone);
  const firstPlan = plans.find((p) => p.id === planId) ?? null;
  const [plan, setPlan] = useState(firstPlan?.id ?? '');
  const [title, setTitle] = useState(firstPlan?.name ?? '');
  const [doneOn, setDoneOn] = useState(today);
  const [cost, setCost] = useState('');
  const [vendor, setVendor] = useState('');
  const [notes, setNotes] = useState('');
  const [usage, setUsage] = useState('');
  const [money, setMoney] = useState<MoneyMode>('new');
  const pickable = pickableAccounts(accounts);
  const [accountId, setAccountId] = useState<string | null>(() => {
    const last = lastAccount();
    return pickable.find((a) => a.id === last)?.id ?? pickable[0]?.id ?? null;
  });
  const [categoryId, setCategoryId] = useState<string | null>(repairsCategory(categories, firstPlan));
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const costValue = cost.trim() ? parseAmount(cost) : null;
  const recent = useQuery({ ...recentExpensesQuery(householdId, addDaysIso(doneOn || today, -45)), enabled: money === 'link' });
  const candidates = useMemo(() => {
    const rows = recent.data ?? [];
    // Closest in amount and date first: the technician's bill that came in by SMS or scan.
    return [...rows].sort((a, b) => {
      const da = Math.abs(daysBetween(a.occurred_on, doneOn || today));
      const db = Math.abs(daysBetween(b.occurred_on, doneOn || today));
      const ca = costValue ? Math.abs(Number(a.total) - costValue) : 0;
      const cb = costValue ? Math.abs(Number(b.total) - costValue) : 0;
      return ca - cb || da - db;
    });
  }, [recent.data, costValue, doneOn, today]);
  const selectedPlan = plans.find((p) => p.id === plan);

  function pickPlan(id: string) {
    setPlan(id);
    const p = plans.find((x) => x.id === id);
    if (p && !title.trim()) setTitle(p.name ?? '');
    if (p?.category_id) setCategoryId(p.category_id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    if (cost.trim() && costValue === null) {
      toast.error(t('things.errors.invalid'));
      return;
    }
    const withExpense = money === 'new' && costValue !== null && costValue > 0;
    if (withExpense && (!accountId || !categoryId)) {
      toast.error(t('maintenance.log.needAccount'));
      return;
    }
    if (money === 'link' && !linkId) {
      toast.error(t('maintenance.log.pickExpense'));
      return;
    }
    setBusy(true);
    const payee = vendor.trim() || title.trim();
    const fp = withExpense
      ? manualFingerprint({ type: 'expense', date: doneOn, accountId: accountId!, payee, total: costValue! })
      : '';
    try {
      const res = await logMaintenance({
        asset_id: asset.id,
        plan_id: plan || null,
        done_on: doneOn,
        title: title.trim(),
        notes: notes.trim() || null,
        vendor: vendor.trim() || null,
        usage_reading: usage.trim() ? Number(usage) : null,
        cost: money === 'link' && !cost.trim() ? undefined : costValue,
        expense: withExpense
          ? {
              account_id: accountId!,
              category_id: categoryId!,
              fingerprint: fp,
              line_fingerprint: lineFingerprint(fp, 0, `${asset.name} — ${title.trim()}`.slice(0, 200), costValue!),
            }
          : undefined,
        link_transaction_id: money === 'link' ? linkId! : undefined,
      });
      if (withExpense && accountId) rememberAccount(accountId, payee);
      await invalidateThings(qc, householdId);
      toast.success(withExpense ? t('maintenance.log.savedWithExpense') : t('maintenance.log.saved'), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            deleteLog(res.id, true)
              .then(() => invalidateThings(qc, householdId))
              .then(() => toast(t('maintenance.log.undone')))
              .catch((err: unknown) => toast.error(t(`things.errors.${thingsErrorKey(err)}`)));
          },
        },
      });
      onClose();
    } catch (err) {
      const key = thingsErrorKey(err);
      toast.error(key === 'duplicate' ? t('maintenance.log.duplicate') : t(`things.errors.${key}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="log-service">
      {plans.length > 0 && (
        <div>
          <label htmlFor="log-plan" className={fieldLabel}>
            {t('maintenance.log.plan')}
          </label>
          <select id="log-plan" className={selectClass} value={plan} onChange={(e) => pickPlan(e.target.value)}>
            <option value="">{t('maintenance.log.noPlan')}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id ?? ''}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="log-title" className={fieldLabel}>
          {t('maintenance.log.what')}
        </label>
        <Input
          id="log-title"
          value={title}
          maxLength={120}
          required
          placeholder={t('maintenance.log.whatPlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="log-date" className={fieldLabel}>
            {t('maintenance.log.date')}
          </label>
          <Input id="log-date" type="date" value={doneOn} max={today} required onChange={(e) => setDoneOn(e.target.value)} className="tabular" />
        </div>
        <div>
          <label htmlFor="log-cost" className={fieldLabel}>
            {t('maintenance.log.cost')}
          </label>
          <Input id="log-cost" inputMode="decimal" value={cost} placeholder="0.00" onChange={(e) => setCost(e.target.value)} className="tabular" />
        </div>
      </div>
      <div>
        <label htmlFor="log-vendor" className={fieldLabel}>
          {t('maintenance.log.vendor')}
        </label>
        <Input id="log-vendor" value={vendor} maxLength={120} onChange={(e) => setVendor(e.target.value)} />
      </div>

      <fieldset className="glass flex flex-col gap-3 rounded-2xl p-3">
        <legend className="sr-only">{t('maintenance.log.money')}</legend>
        <div role="radiogroup" aria-label={t('maintenance.log.money')} className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.03] p-1">
          {(['new', 'link', 'none'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={money === m}
              onClick={() => setMoney(m)}
              className={cn('h-10 rounded-lg px-1 text-[12.5px] font-medium leading-tight', money === m ? 'accent-pill text-text' : 'text-muted')}
            >
              {t(`maintenance.log.moneyModes.${m}`)}
            </button>
          ))}
        </div>
        {money === 'new' && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="log-account" className={fieldLabel}>
                {t('maintenance.log.paidFrom')}
              </label>
              <AccountSelect id="log-account" accounts={pickable} value={accountId} onChange={setAccountId} />
            </div>
            <div>
              <label htmlFor="log-category" className={fieldLabel}>
                {t('maintenance.log.category')}
              </label>
              <CategorySelect id="log-category" categories={categories} value={categoryId} onChange={setCategoryId} kind="expense" />
            </div>
            <p className="text-[12.5px] text-muted sm:col-span-2">{t('maintenance.log.newHint')}</p>
          </div>
        )}
        {money === 'link' && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[12.5px] text-muted">{t('maintenance.log.linkHint')}</p>
            {recent.isPending ? (
              <div className="h-14 animate-pulse rounded-xl bg-white/5" aria-hidden />
            ) : candidates.length === 0 ? (
              <p className="text-[13.5px] text-[#a5b0d0]">{t('maintenance.log.noExpenses')}</p>
            ) : (
              <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label={t('maintenance.log.pickExpense')}>
                {candidates.slice(0, 20).map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={linkId === x.id}
                      onClick={() => setLinkId(x.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px]',
                        linkId === x.id ? 'accent-pill' : 'bg-white/[0.03]',
                      )}
                    >
                      <span className="tabular w-16 shrink-0 text-[12.5px] text-muted">{formatDay(x.occurred_on, locale)}</span>
                      <span className="min-w-0 flex-1 truncate">{x.payee_text ?? '—'}</span>
                      <Money value={Number(x.total)} className="text-[13.5px]" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {money === 'none' && <p className="text-[12.5px] text-muted">{t('maintenance.log.noneHint')}</p>}
      </fieldset>

      <details className="glass rounded-2xl px-4 py-3">
        <summary className="cursor-pointer text-[14px] font-medium">{t('things.form.more')}</summary>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="log-usage" className={fieldLabel}>
              {t('maintenance.log.usage', { unit: selectedPlan?.usage_unit ?? '' })}
            </label>
            <Input id="log-usage" inputMode="decimal" value={usage} onChange={(e) => setUsage(e.target.value)} className="tabular" />
          </div>
          <div>
            <label htmlFor="log-notes" className={fieldLabel}>
              {t('maintenance.log.notes')}
            </label>
            <textarea id="log-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaClass} />
          </div>
        </div>
      </details>

      <Button type="submit" variant="primary" disabled={busy || !title.trim()} className="w-full">
        {busy ? (
          t('common.saving')
        ) : money === 'new' && costValue ? (
          <>
            {t('maintenance.log.saveWith')} <Money value={costValue} />
          </>
        ) : (
          t('maintenance.log.save')
        )}
      </Button>
    </form>
  );
}

const PRESETS = [30, 90, 180, 365, 730] as const;

/** A recurring job on a thing: every N days (or every N km …), next due, which expense category. */
export function PlanSheet({
  open,
  onClose,
  householdId,
  timezone,
  asset,
  plan,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  asset: Asset;
  plan?: Plan | null;
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={plan ? t('maintenance.plan.editTitle') : t('maintenance.plan.newTitle', { name: asset.name })}>
      {open && <PlanBody onClose={onClose} householdId={householdId} timezone={timezone} asset={asset} plan={plan} categories={categories} />}
    </Sheet>
  );
}

function PlanBody({
  onClose,
  householdId,
  timezone,
  asset,
  plan,
  categories,
}: {
  onClose: () => void;
  householdId: string;
  timezone: string;
  asset: Asset;
  plan?: Plan | null;
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const today = todayIn(timezone);
  const [name, setName] = useState(plan?.name ?? '');
  const [everyDays, setEveryDays] = useState(plan?.every_days ? String(plan.every_days) : '180');
  const [everyUsage, setEveryUsage] = useState(plan?.every_usage ? String(plan.every_usage) : '');
  const [usageUnit, setUsageUnit] = useState(plan?.usage_unit ?? '');
  const [nextDue, setNextDue] = useState(plan?.next_due ?? addDaysIso(today, 180));
  const [touchedDue, setTouchedDue] = useState(Boolean(plan));
  const [notify, setNotify] = useState(String(plan?.notify_days_before ?? 7));
  const [categoryId, setCategoryId] = useState<string | null>(plan?.category_id ?? repairsCategory(categories));
  const [active, setActive] = useState(plan?.active ?? true);
  const [notes, setNotes] = useState(plan?.notes ?? '');
  const [busy, setBusy] = useState(false);

  function pickEvery(v: string) {
    setEveryDays(v);
    const n = Number(v);
    if (!touchedDue && Number.isFinite(n) && n > 0) setNextDue(addDaysIso(today, Math.round(n)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const days = everyDays.trim() ? Math.round(Number(everyDays)) : null;
    const usage = everyUsage.trim() ? Number(everyUsage) : null;
    if ((days !== null && !(days >= 1 && days <= 3650)) || (usage !== null && !(usage > 0))) {
      toast.error(t('things.errors.invalid'));
      return;
    }
    setBusy(true);
    try {
      await savePlan(
        householdId,
        asset.id,
        {
          name: name.trim(),
          category_id: categoryId,
          every_days: days,
          every_usage: usage,
          usage_unit: usage !== null ? usageUnit.trim() || null : null,
          next_due: nextDue || null,
          notify_days_before: Math.max(0, Math.min(365, Math.round(Number(notify) || 0))),
          active,
          notes: notes.trim() || null,
        },
        plan?.id ?? undefined,
      );
      await invalidateThings(qc, householdId);
      toast.success(t('maintenance.plan.saved', { name: name.trim() }));
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan?.id) return;
    setBusy(true);
    try {
      await deletePlan(plan.id);
      await invalidateThings(qc, householdId);
      toast.success(t('maintenance.plan.deleted', { name: plan.name }));
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="plan-form">
      <div>
        <label htmlFor="plan-name" className={fieldLabel}>
          {t('maintenance.plan.name')}
        </label>
        <Input id="plan-name" value={name} maxLength={80} required placeholder={t('maintenance.plan.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <span className={fieldLabel}>{t('maintenance.plan.every')}</span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={everyDays === String(d)}
              onClick={() => pickEvery(String(d))}
              className={cn('h-9 rounded-full px-3.5 text-[13.5px]', everyDays === String(d) ? 'accent-pill text-text' : 'glass text-muted')}
            >
              {t(`maintenance.plan.presets.d${d}`)}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <Input
            aria-label={t('maintenance.plan.everyDays')}
            inputMode="numeric"
            value={everyDays}
            onChange={(e) => pickEvery(e.target.value)}
            className="tabular w-24"
          />
          <span className="text-[13.5px] text-muted">{t('maintenance.plan.days')}</span>
        </div>
      </div>
      <div>
        <label htmlFor="plan-due" className={fieldLabel}>
          {t('maintenance.plan.nextDue')}
        </label>
        <Input
          id="plan-due"
          type="date"
          value={nextDue}
          onChange={(e) => {
            setNextDue(e.target.value);
            setTouchedDue(true);
          }}
          className="tabular"
        />
      </div>

      <details className="glass rounded-2xl px-4 py-3">
        <summary className="cursor-pointer text-[14px] font-medium">{t('things.form.more')}</summary>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="plan-category" className={fieldLabel}>
              {t('maintenance.plan.category')}
            </label>
            <CategorySelect id="plan-category" categories={categories} value={categoryId} onChange={setCategoryId} kind="expense" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <div>
              <label htmlFor="plan-usage" className={fieldLabel}>
                {t('maintenance.plan.everyUsage')}
              </label>
              <Input id="plan-usage" inputMode="decimal" value={everyUsage} onChange={(e) => setEveryUsage(e.target.value)} className="tabular" />
            </div>
            <div>
              <label htmlFor="plan-usage-unit" className={fieldLabel}>
                {t('maintenance.plan.usageUnit')}
              </label>
              <Input id="plan-usage-unit" value={usageUnit} maxLength={12} placeholder="km" onChange={(e) => setUsageUnit(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Input
              aria-label={t('maintenance.plan.notify')}
              inputMode="numeric"
              value={notify}
              onChange={(e) => setNotify(e.target.value)}
              className="tabular w-20"
            />
            <span className="text-[13.5px] text-muted">{t('maintenance.plan.notify')}</span>
          </div>
          <label className="flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
            {t('maintenance.plan.active')}
          </label>
          <div>
            <label htmlFor="plan-notes" className={fieldLabel}>
              {t('maintenance.log.notes')}
            </label>
            <textarea id="plan-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaClass} />
          </div>
        </div>
      </details>

      <Button type="submit" variant="primary" disabled={busy || !name.trim()} className="w-full">
        {busy ? t('common.saving') : t('maintenance.plan.save')}
      </Button>
      {plan && (
        <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
          <Trash className="h-4 w-4" aria-hidden />
          {t('maintenance.plan.delete')}
        </Button>
      )}
    </form>
  );
}
