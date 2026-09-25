import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AccountSelect, CategorySelect, fieldLabel, selectClass } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { invalidateInsights } from '@/lib/insights/queries';
import { formatLKR, parseAmount } from '@/lib/money/format';
import { deleteTransaction, invalidateMoney, lastAccount, pickableAccounts, type Account } from '@/lib/money/queries';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { EVERY_UNITS, PRESETS, USAGE_UNITS, suggestPayments, type EveryUnit, type UsageUnit } from '@/lib/recurring/match';
import {
  createRule,
  deleteRule,
  linkCandidatesQuery,
  linkRecurring,
  payRecurring,
  recurringErrorKey,
  updateRule,
  type RecurringRule,
  type RuleInput,
} from '@/lib/recurring/queries';
import { assetsQuery } from '@/lib/things/queries';
import { UNDO_MS } from '@/lib/undo';
import { formatDay } from '@/lib/time';

/** The account to start with: the rule's, else the last one used on this device, else the first. */
function defaultAccount(accounts: Account[], preferred: string | null): string | null {
  const pickable = pickableAccounts(accounts);
  const last = lastAccount();
  return preferred ?? (pickable.some((a) => a.id === last) ? last : (pickable[0]?.id ?? null));
}

async function refresh(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  await Promise.all([invalidateMoney(qc, householdId), invalidateInsights(qc, householdId)]);
}

// ── Pay ───────────────────────────────────────────────────────────────────────
export function PaySheet({
  rule,
  householdId,
  accounts,
  categories,
  today,
  locale,
  onClose,
}: {
  rule: RecurringRule | null;
  householdId: string;
  accounts: Account[];
  categories: CategoryRow[];
  today: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const open = rule !== null;
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [picked, setAccount] = useState<string | null>(null);
  // Accounts may still be loading when the sheet opens (a shared ?pay= link): fill in when they arrive.
  const account = picked ?? (rule ? defaultAccount(accounts, rule.account_id) : null);
  const [category, setCategory] = useState<string | null>(null);
  const [units, setUnits] = useState('');
  const [busy, setBusy] = useState(false);
  const [forRule, setForRule] = useState<string | null>(null);

  // Prefill when a (new) rule opens.
  if (rule && forRule !== rule.id) {
    setForRule(rule.id);
    setAmount(String(rule.expected_amount ?? rule.last_amount ?? ''));
    setDate(today);
    setAccount(null);
    setCategory(rule.category_id);
    setUnits('');
  }

  async function save() {
    if (!rule) return;
    const total = parseAmount(amount);
    const u = units.trim() ? Number(units.replace(/,/g, '')) : null;
    if (total === null || total <= 0 || !account || (u !== null && !(u > 0))) {
      toast.error(t('recurring.errors.invalid'));
      return;
    }
    setBusy(true);
    try {
      const res = await payRecurring({
        rule,
        account_id: account,
        category_id: category,
        occurred_on: date,
        total,
        payee_text: rule.payee_text,
        notes: null,
        units: u,
      });
      await refresh(qc, householdId);
      toast.success(t('recurring.paid', { name: rule.name, period: formatDay(res.period, locale) }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            deleteTransaction(res.id)
              .then(() => refresh(qc, householdId))
              .then(() => toast(t('recurring.payUndone')))
              .catch((e: unknown) => toast.error(t(`recurring.errors.${recurringErrorKey(e)}`)));
          },
        },
      });
      setForRule(null);
      onClose();
    } catch (e) {
      toast.error(t(`recurring.errors.${recurringErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={() => { setForRule(null); onClose(); }} title={rule ? t('recurring.payTitle', { name: rule.name }) : ''}>
      {rule && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-[13.5px] text-muted">{t('recurring.payFor', { date: formatDay(rule.next_due, locale) })}</p>
          <div>
            <label htmlFor="pay-amount" className={fieldLabel}>
              {t('recurring.amount')}
            </label>
            <Input id="pay-amount" inputMode="decimal" className="tabular" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </div>
          {rule.usage_unit && (
            <div>
              <label htmlFor="pay-units" className={fieldLabel}>
                {t('recurring.unitsUsed', { unit: rule.usage_unit })}
              </label>
              <Input id="pay-units" inputMode="decimal" className="tabular" value={units} onChange={(e) => setUnits(e.target.value)} />
            </div>
          )}
          <div>
            <label htmlFor="pay-date" className={fieldLabel}>
              {t('recurring.paidOn')}
            </label>
            <Input id="pay-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pay-account" className={fieldLabel}>
              {t('recurring.account')}
            </label>
            <AccountSelect id="pay-account" accounts={pickableAccounts(accounts, account)} value={account} onChange={setAccount} />
          </div>
          <div>
            <label htmlFor="pay-category" className={fieldLabel}>
              {t('recurring.category')}
            </label>
            <CategorySelect id="pay-category" categories={categories} value={category} onChange={setCategory} kind={rule.type} />
          </div>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('recurring.pay')}
          </Button>
        </form>
      )}
    </Sheet>
  );
}

// ── Link a bill already in Money ──────────────────────────────────────────────
export function LinkSheet({
  rule,
  householdId,
  today,
  locale,
  onClose,
}: {
  rule: RecurringRule | null;
  householdId: string;
  today: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const candidates = useQuery({ ...linkCandidatesQuery(householdId, today), enabled: rule !== null });
  const [units, setUnits] = useState('');
  const [busy, setBusy] = useState(false);
  const suggested = rule ? suggestPayments(rule, candidates.data ?? []) : [];
  const others = rule
    ? (candidates.data ?? []).filter((c) => c.type === rule.type && !suggested.includes(c)).slice(0, 15)
    : [];

  async function link(txId: string) {
    if (!rule) return;
    const u = units.trim() ? Number(units.replace(/,/g, '')) : null;
    setBusy(true);
    try {
      const period = await linkRecurring(rule.id, txId, u);
      await refresh(qc, householdId);
      toast.success(t('recurring.linked', { name: rule.name, period: formatDay(period, locale) }));
      setUnits('');
      onClose();
    } catch (e) {
      toast.error(t(`recurring.errors.${recurringErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  const row = (c: (typeof suggested)[number]) => (
    <li key={c.id}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void link(c.id)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px]">{c.payee_text ?? '—'}</span>
          <span className="block text-[12.5px] text-muted">{formatDay(c.occurred_on, locale)}</span>
        </span>
        <span className="tabular">{formatLKR(c.total)}</span>
      </button>
    </li>
  );

  return (
    <Sheet open={rule !== null} onClose={onClose} title={rule ? t('recurring.linkTitle', { name: rule.name }) : ''}>
      {rule && (
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] text-muted">{t('recurring.linkIntro', { date: formatDay(rule.next_due, locale) })}</p>
          {rule.usage_unit && (
            <div>
              <label htmlFor="link-units" className={fieldLabel}>
                {t('recurring.unitsUsed', { unit: rule.usage_unit })}
              </label>
              <Input id="link-units" inputMode="decimal" className="tabular" value={units} onChange={(e) => setUnits(e.target.value)} />
            </div>
          )}
          {!candidates.data ? (
            <div className="glass h-24 animate-pulse rounded-2xl" aria-hidden />
          ) : suggested.length + others.length === 0 ? (
            <p className="text-[14px] text-muted">{t('recurring.noCandidates')}</p>
          ) : (
            <>
              {suggested.length > 0 && (
                <section>
                  <h3 className="mb-1 text-[12.5px] font-medium text-muted uppercase">{t('recurring.suggested')}</h3>
                  <ul>{suggested.map(row)}</ul>
                </section>
              )}
              {others.length > 0 && (
                <section>
                  <h3 className="mb-1 text-[12.5px] font-medium text-muted uppercase">{t('recurring.recent')}</h3>
                  <ul>{others.map(row)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ── Add / edit a recurring bill ───────────────────────────────────────────────
export function RuleSheet({
  open,
  rule,
  householdId,
  accounts,
  categories,
  today,
  preset,
  onClose,
}: {
  open: boolean;
  rule: RecurringRule | null;
  householdId: string;
  accounts: Account[];
  categories: CategoryRow[];
  today: string;
  preset?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const assets = useQuery({ ...assetsQuery(householdId), enabled: open });
  const init = (): RuleInput => {
    if (rule) {
      const { name, type, account_id, category_id, payee_text, expected_amount, every_n, every_unit, first_due, notify_days_before, usage_unit, asset_id, notes, active } = rule;
      return { name, type, account_id, category_id, payee_text, expected_amount, every_n, every_unit, first_due, notify_days_before, usage_unit, asset_id, notes, active };
    }
    const p = PRESETS.find((x) => x.key === preset);
    const sub = p ? categories.find((c) => c.parent_id !== null && c.name.toLowerCase() === p.sub.toLowerCase()) : undefined;
    return {
      name: p?.name ?? '',
      type: 'expense',
      account_id: defaultAccount(accounts, null),
      category_id: sub?.id ?? null,
      payee_text: null,
      expected_amount: null,
      every_n: p?.every[0] ?? 1,
      every_unit: p?.every[1] ?? 'month',
      first_due: today,
      notify_days_before: 3,
      usage_unit: p?.usage ?? null,
      asset_id: null,
      notes: null,
      active: true,
    };
  };
  const [form, setForm] = useState<RuleInput>(init);
  const [amount, setAmount] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const openKey = open ? `${rule?.id ?? 'new'}:${preset ?? ''}` : null;
  if (openKey !== key) {
    setKey(openKey);
    if (openKey) {
      const f = init();
      setForm(f);
      setAmount(f.expected_amount !== null ? String(f.expected_amount) : '');
      setAdvanced(false);
    }
  }
  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  // A new bill opened straight from a link: the accounts may arrive after the form.
  const accountId = form.account_id ?? (rule ? null : defaultAccount(accounts, null));

  async function save() {
    const expected = amount.trim() ? parseAmount(amount) : null;
    if (!form.name.trim() || (amount.trim() && (expected === null || expected < 0)) || !form.first_due || !(form.every_n >= 1)) {
      toast.error(t('recurring.errors.invalid'));
      return;
    }
    setBusy(true);
    try {
      const input = { ...form, account_id: accountId, name: form.name.trim(), expected_amount: expected };
      if (rule) await updateRule(rule.id, input);
      else await createRule(householdId, input);
      await refresh(qc, householdId);
      toast.success(t(rule ? 'recurring.saved' : 'recurring.added', { name: input.name }));
      onClose();
    } catch (e) {
      toast.error(t(`recurring.errors.${recurringErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!window.confirm(t('recurring.deleteConfirm', { name: rule.name }))) return;
    setBusy(true);
    try {
      await deleteRule(rule.id);
      await refresh(qc, householdId);
      toast(t('recurring.deleted', { name: rule.name }));
      onClose();
    } catch (e) {
      toast.error(t(`recurring.errors.${recurringErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={rule ? t('recurring.editTitle') : t('recurring.addTitle')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor="rule-name" className={fieldLabel}>
            {t('recurring.name')}
          </label>
          <Input id="rule-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('recurring.namePlaceholder')} />
        </div>
        <div>
          <label htmlFor="rule-category" className={fieldLabel}>
            {t('recurring.category')}
          </label>
          <CategorySelect id="rule-category" categories={categories} value={form.category_id} onChange={(v) => set('category_id', v)} kind={form.type} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rule-amount" className={fieldLabel}>
              {t('recurring.usualAmount')}
            </label>
            <Input id="rule-amount" inputMode="decimal" className="tabular" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label htmlFor="rule-due" className={fieldLabel}>
              {t('recurring.firstDue')}
            </label>
            <Input id="rule-due" type="date" value={form.first_due} onChange={(e) => set('first_due', e.target.value)} />
          </div>
        </div>
        <div>
          <span className={fieldLabel}>{t('recurring.repeats')}</span>
          <div className="flex gap-2">
            <Input
              aria-label={t('recurring.everyN')}
              inputMode="numeric"
              className="tabular w-20"
              value={String(form.every_n)}
              onChange={(e) => set('every_n', Math.max(1, Math.min(366, Number(e.target.value.replace(/\D/g, '')) || 1)))}
            />
            <select aria-label={t('recurring.everyUnit')} className={selectClass} value={form.every_unit} onChange={(e) => set('every_unit', e.target.value as EveryUnit)}>
              {EVERY_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`recurring.every.${u}`, { count: form.every_n })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="rule-account" className={fieldLabel}>
            {t('recurring.account')}
          </label>
          <AccountSelect id="rule-account" accounts={pickableAccounts(accounts, accountId)} value={accountId} onChange={(v) => set('account_id', v)} />
        </div>

        <button type="button" className="self-start text-[13.5px] text-accent-b" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          {advanced ? t('recurring.lessOptions') : t('recurring.moreOptions')}
        </button>
        {advanced && (
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="rule-type" className={fieldLabel}>
                {t('recurring.type')}
              </label>
              <select id="rule-type" className={selectClass} value={form.type} onChange={(e) => set('type', e.target.value as 'expense' | 'income')}>
                <option value="expense">{t('money.types.expense')}</option>
                <option value="income">{t('money.types.income')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="rule-payee" className={fieldLabel}>
                {t('recurring.payee')}
              </label>
              <Input id="rule-payee" value={form.payee_text ?? ''} onChange={(e) => set('payee_text', e.target.value || null)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rule-units" className={fieldLabel}>
                  {t('recurring.trackUnits')}
                </label>
                <select id="rule-units" className={selectClass} value={form.usage_unit ?? ''} onChange={(e) => set('usage_unit', (e.target.value || null) as UsageUnit | null)}>
                  <option value="">{t('recurring.noUnits')}</option>
                  {USAGE_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rule-notify" className={fieldLabel}>
                  {t('recurring.notifyDays')}
                </label>
                <Input
                  id="rule-notify"
                  inputMode="numeric"
                  className="tabular"
                  value={String(form.notify_days_before)}
                  onChange={(e) => set('notify_days_before', Math.max(0, Math.min(60, Number(e.target.value.replace(/\D/g, '')) || 0)))}
                />
              </div>
            </div>
            <div>
              <label htmlFor="rule-asset" className={fieldLabel}>
                {t('recurring.asset')}
              </label>
              <select id="rule-asset" className={selectClass} value={form.asset_id ?? ''} onChange={(e) => set('asset_id', e.target.value || null)}>
                <option value="">{t('recurring.noAsset')}</option>
                {(assets.data ?? [])
                  .filter((a) => !['sold', 'disposed', 'lost'].includes(a.status) || a.id === form.asset_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.tag} · {a.name}
                    </option>
                  ))}
              </select>
            </div>
            {rule && (
              <label className="flex items-center gap-3 text-[14.5px]">
                <input type="checkbox" checked={form.active ?? true} onChange={(e) => set('active', e.target.checked)} className="h-5 w-5" />
                {t('recurring.active')}
              </label>
            )}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {rule ? t('common.save') : t('recurring.add')}
        </Button>
        {rule && (
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {t('recurring.delete')}
          </Button>
        )}
      </form>
    </Sheet>
  );
}
