import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { BadgeCheck, ChevronLeft, CircleCheck, History, MessageSquareText, PackageOpen, RefreshCw, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/aurora/EmptyState';
import { CategorySelect, Money, fieldLabel, selectClass } from '@/components/money/bits';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { memoryQuery } from '@/lib/match/memory';
import {
  TooOften,
  checkNow,
  decide,
  dropDuplicate,
  linkLineProduct,
  matchSettingQuery,
  pastAlertsQuery,
  rebook,
  setLineCategory,
  suggestionsQuery,
  type PastAlert,
  type Suggestion,
} from '@/lib/match/queries';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { manualFingerprint } from '@/lib/money/fingerprint';
import { formatLKR } from '@/lib/money/format';
import { invalidateMoney, moneyErrorKey, saveTransaction, type Account } from '@/lib/money/queries';
import { productsQuery } from '@/lib/pantry/queries';
import { formatDay, todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/money/review')({
  component: ReviewPage,
});

/**
 * "Needs you" (Phase 9b): what the matcher worked out — the rules first, the AI for the rest — and
 * nothing is saved until a person says so. Bill lines are decided here; alerts and things show their
 * suggestions where they are handled (Bank alerts, Bought-not-entered).
 */
function ReviewPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const { categories, accounts } = useMoneyBasics(householdId);
  const products = useQuery(productsQuery(householdId));
  const suggestions = useQuery(suggestionsQuery(householdId));
  const setting = useQuery(matchSettingQuery(householdId));
  const [checking, setChecking] = useState(false);

  const lines = useMemo(
    () => (suggestions.data ?? []).filter((s) => (s.task === 'line_product' || s.task === 'line_category') && s.line),
    [suggestions.data],
  );
  // Phase 9b.1: past bookings the evidence disagrees with
  const past = useMemo(
    () => (suggestions.data ?? []).filter((s) => s.task === 'sms_rebook' || s.task === 'sms_recategorise' || s.task === 'sms_topup' || s.task === 'sms_duplicate'),
    [suggestions.data],
  );
  const pastIds = useMemo(
    () => [...new Set(past.flatMap((s) => [s.sms_id, s.proposal.payment_sms, s.proposal.receipt_sms]).filter((x): x is string => !!x))],
    [past],
  );
  const pastAlerts = useQuery(pastAlertsQuery(householdId, pastIds));
  const alerts = (suggestions.data ?? []).filter((s) => s.task === 'sms_category' || s.task === 'sms_link').length;
  const things = (suggestions.data ?? []).filter((s) => s.task === 'line_thing').length;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: suggestionsQuery(householdId).queryKey });
    void qc.invalidateQueries({ queryKey: memoryQuery(householdId).queryKey });
    void invalidateMoney(qc, householdId);
  };

  async function runNow() {
    setChecking(true);
    try {
      const r = await checkNow(householdId);
      toast.success(t('match.checked', { count: Number(r.stats.suggestions ?? 0) }));
      refresh();
    } catch (err) {
      toast.error(err instanceof TooOften ? t('match.tooOften') : t('match.failed'));
    } finally {
      setChecking(false);
    }
  }

  const loading = suggestions.isPending || categories.isPending || products.isPending;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/money" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.money')}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('match.title')}</h1>
          <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('match.intro')}</p>
        </div>
        {canWrite && (
          <Button variant="secondary" size="sm" disabled={checking} onClick={() => void runNow()}>
            <RefreshCw className={cn('h-4 w-4', checking && 'motion-safe:animate-spin')} aria-hidden />
            {t('match.checkNow')}
          </Button>
        )}
      </div>

      {setting.data && !setting.data.ai_enabled && (
        <Card className="flex flex-wrap items-center gap-3 text-[14px] text-muted">
          <Sparkles className="h-4 w-4 text-info" aria-hidden />
          <span className="min-w-0 flex-1">{t('match.aiOff')}</span>
          <Link to="/settings/matching" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('match.settingsLink')}
          </Link>
        </Card>
      )}

      {(alerts > 0 || things > 0) && (
        <div className="flex flex-wrap gap-2">
          {alerts > 0 && (
            <Link to="/money/inbox" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <MessageSquareText className="h-4 w-4" aria-hidden />
              {t('match.alertsWaiting', { count: alerts })}
            </Link>
          )}
          {things > 0 && (
            <Link to="/things/pending" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <PackageOpen className="h-4 w-4" aria-hidden />
              {t('match.thingsWaiting', { count: things })}
            </Link>
          )}
        </div>
      )}

      {loading ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : suggestions.isError ? (
        <Card className="text-[14px] text-muted">{t('money.loadError')}</Card>
      ) : lines.length === 0 && past.length === 0 ? (
        <EmptyState icon={CircleCheck} title={t('match.emptyTitle')} body={t('match.emptyBody')} />
      ) : (
        <>
        {past.length > 0 && (
          <section className="flex flex-col gap-2.5" aria-labelledby="past-title">
            <div>
              <h2 id="past-title" className="flex items-center gap-2 font-display text-[19px] font-semibold">
                <History className="h-[18px] w-[18px] text-info" aria-hidden />
                {t('match.past.title')}
              </h2>
              <p className="mt-0.5 max-w-prose text-[13.5px] text-muted">{t('match.past.intro')}</p>
            </div>
            <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
              {past.map((s) => (
                <PastBooking
                  key={s.id}
                  s={s}
                  householdId={householdId}
                  locale={locale}
                  today={today}
                  canWrite={canWrite}
                  categories={categories.data ?? []}
                  accounts={accounts.data ?? []}
                  alerts={pastAlerts.data}
                  onDone={refresh}
                />
              ))}
            </ul>
          </section>
        )}
        {lines.length > 0 && (
        <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]" aria-label={t('match.linesTitle')}>
          {lines.map((s) => (
            <LineSuggestion
              key={s.id}
              s={s}
              locale={locale}
              today={today}
              canWrite={canWrite}
              categories={categories.data ?? []}
              products={(products.data ?? []).filter((p) => !p.archived && !p.merged_into_id).map((p) => ({ id: p.id, name: p.name }))}
              onDone={refresh}
            />
          ))}
        </ul>
        )}
        </>
      )}
    </div>
  );
}

/**
 * One past booking the evidence disagrees with (9b.1). Fix does it in one database step; Keep leaves the
 * booking and remembers the answer (the same evidence isn't asked about again).
 */
function PastBooking({
  s,
  householdId,
  locale,
  today,
  canWrite,
  categories,
  accounts,
  alerts,
  onDone,
}: {
  s: Suggestion;
  householdId: string;
  locale: string;
  today: string;
  canWrite: boolean;
  categories: CategoryRow[];
  accounts: Account[];
  alerts: Map<string, PastAlert> | undefined;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const p = s.proposal;
  const debit = s.sms_id ? alerts?.get(s.sms_id) : undefined;
  const payment = p.payment_sms ? alerts?.get(p.payment_sms) : undefined;
  const accountName = (id: string | null | undefined) => accounts.find((a) => a.id === id)?.name ?? '?';
  const catName = (id: string | null | undefined) => {
    const c = categories.find((x) => x.id === id);
    const top = c?.parent_id ? categories.find((x) => x.id === c.parent_id) : null;
    return c ? (top ? `${top.name} › ${c.name}` : c.name) : t('match.past.noCategory');
  };
  const money = (n: number | null | undefined) => formatLKR(Number(n ?? 0));

  const act = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onDone();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };
  const fix = () =>
    act(async () => {
      if (s.task === 'sms_rebook') await rebook(p);
      else if (s.task === 'sms_duplicate') await dropDuplicate(p);
      else if (s.task === 'sms_topup') {
        // the wallet top-up no SMS reported (9b.2): a transfer, dated where the balance shows it
        await saveTransaction({
          household_id: householdId, type: 'transfer', account_id: p.from_account_id!, to_account_id: p.to_account_id!,
          occurred_on: p.occurred_on!, total: p.total!, notes: t('match.past.topupNote'), lines: [],
          fingerprint: manualFingerprint({ type: 'transfer', date: p.occurred_on!, accountId: p.from_account_id!, payee: `topup ${p.to_account_id}`, total: p.total! }),
        });
      } else await setLineCategory(p.line_id!, p.category_id!);
      await decide([s.id], 'accepted');
    }, t('match.done'));
  const keep = () => act(() => decide([s.id], 'rejected'), t('match.past.kept'));

  const what =
    s.task === 'sms_duplicate'
      ? t(p.delete_tx ? 'match.past.duplicate' : 'match.past.duplicateWaiting', {
          bank: debit?.sender ?? '?',
          paid: money(p.total),
          day: p.kept_on ? formatDay(p.kept_on, locale, today.slice(0, 4)) : '?',
        })
      : s.task === 'sms_rebook' && p.own
      ? t('match.past.own', { from: accountName(p.from_account_id), to: accountName(p.to_account_id), paid: money(p.total) })
      : s.task === 'sms_rebook' && p.moved
      ? t(p.fee ? 'match.past.moveFee' : 'match.past.move', {
          was: accountName(p.was_account_id),
          from: accountName(p.from_account_id),
          card: accountName(p.card_account_id),
          paid: money(p.total),
          debit: money(debit?.amount),
          fee: money(p.fee),
        })
      : s.task === 'sms_topup'
      ? t('match.past.topup', {
          from: accountName(p.from_account_id),
          to: accountName(p.to_account_id),
          paid: money(p.total),
          since: p.since ? formatDay(p.since, locale, today.slice(0, 4)) : '?',
          day: p.occurred_on ? formatDay(p.occurred_on, locale, today.slice(0, 4)) : '?',
        })
      : s.task === 'sms_rebook'
      ? t(p.fee ? 'match.past.rebookFee' : 'match.past.rebook', {
          was: catName(p.was_category_id),
          card: accountName(p.card_account_id),
          paid: money(p.total),
          fee: money(p.fee),
        })
      : t('match.past.recategorise', { was: catName(p.was_category_id), payee: p.payee ?? '?', to: catName(p.category_id) });

  return (
    <li className="flex flex-col gap-2.5 px-3.5 py-3.5 sm:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{debit?.merchant_text ?? t('money.inbox.kinds.bank_debit')}</div>
          <div className="truncate text-[12.5px] text-muted">
            {[accountName(debit?.account_id ?? p.from_account_id), debit ? formatDay(debit.occurred_on, locale, today.slice(0, 4)) : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {debit?.amount != null && <Money value={Number(debit.amount)} className="text-[14px]" />}
      </div>
      <p className="flex items-start gap-2 rounded-2xl bg-white/[0.035] px-3 py-2.5 text-[13.5px]">
        <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden />
        <span className="min-w-0 flex-1">
          {what}
          {payment && (
            <span className="block text-[12px] text-muted">
              {t('match.past.paymentSeen', { card: accountName(payment.account_id), day: formatDay(payment.occurred_on, locale, today.slice(0, 4)) })}
            </span>
          )}
        </span>
      </p>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="accent" disabled={busy} onClick={() => void fix()}>
            {t('match.past.fix')}
          </Button>
          <Button size="sm" variant="ghost" className="text-muted" disabled={busy} onClick={() => void keep()}>
            {t('match.past.keep')}
          </Button>
        </div>
      )}
    </li>
  );
}

function LineSuggestion({
  s,
  locale,
  today,
  canWrite,
  categories,
  products,
  onDone,
}: {
  s: Suggestion;
  locale: string;
  today: string;
  canWrite: boolean;
  categories: CategoryRow[];
  products: Array<{ id: string; name: string }>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [productId, setProductId] = useState<string>(s.proposal.product_id ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(s.proposal.category_id ?? s.line?.category_id ?? null);
  const line = s.line!;
  const catName = (id: string | null | undefined) => {
    const c = categories.find((x) => x.id === id);
    const top = c?.parent_id ? categories.find((x) => x.id === c.parent_id) : null;
    return c ? (top ? `${top.name} › ${c.name}` : c.name) : '—';
  };
  const productName = products.find((p) => p.id === s.proposal.product_id)?.name;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onDone();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    act(async () => {
      if (s.task === 'line_product') await linkLineProduct(s.line_id!, s.proposal.product_id ?? null, s.proposal.destiny ?? 'stock');
      else await setLineCategory(s.line_id!, s.proposal.category_id!);
      await decide([s.id], 'accepted');
    }, t('match.done'));

  const saveFix = () =>
    act(async () => {
      if (s.task === 'line_product') {
        if (!productId) throw new Error('pick');
        await linkLineProduct(s.line_id!, productId, 'stock');
        await decide([s.id], productId === s.proposal.product_id ? 'accepted' : 'changed', { product_id: productId, destiny: 'stock' });
      } else {
        if (!categoryId) throw new Error('pick');
        await setLineCategory(s.line_id!, categoryId);
        await decide([s.id], categoryId === s.proposal.category_id ? 'accepted' : 'changed', { category_id: categoryId });
      }
    }, t('match.done'));

  const notPantry = () =>
    act(async () => {
      await linkLineProduct(s.line_id!, null, 'expense');
      await decide([s.id], 'changed', { destiny: 'expense' });
    }, t('match.done'));

  const reject = () => act(() => decide([s.id], 'rejected'), t('match.skipped'));

  const what =
    s.task === 'line_category'
      ? t('match.proposeCategory', { to: catName(s.proposal.category_id), from: catName(line.category_id) })
      : s.proposal.destiny === 'expense'
        ? t('match.proposeNotPantry')
        : t('match.proposeProduct', { name: productName ?? '?' });

  return (
    <li className="flex flex-col gap-2.5 px-3.5 py-3.5 sm:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{line.raw_name}</div>
          <div className="truncate text-[12.5px] text-muted">
            {[line.transaction?.payee_text, line.transaction ? formatDay(line.transaction.occurred_on, locale, today.slice(0, 4)) : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <Money value={Number(line.amount)} className="text-[14px]" />
      </div>
      <p className="flex items-start gap-2 rounded-2xl bg-white/[0.035] px-3 py-2.5 text-[13.5px]">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
        <span className="min-w-0 flex-1">
          {what}
          <span className="block text-[12px] text-muted" title={s.models.join(', ')}>
            {t('match.howSure', { pct: Math.round(s.confidence * 100), how: t(`match.patterns.${patternKey(s.pattern)}`) })}
          </span>
        </span>
      </p>
      {canWrite && !fixing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="accent" disabled={busy} onClick={() => void accept()}>
            {t('match.accept')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFixing(true)}>
            {t('match.fix')}
          </Button>
          {s.task === 'line_product' && s.proposal.destiny !== 'expense' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void notPantry()}>
              {t('match.notPantry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-muted" disabled={busy} onClick={() => void reject()}>
            {t('match.skip')}
          </Button>
        </div>
      )}
      {canWrite && fixing && (
        <div className="flex flex-col gap-2.5 rounded-2xl bg-white/[0.035] p-3">
          {s.task === 'line_product' ? (
            <div>
              <label className={fieldLabel} htmlFor={`fix-p-${s.id}`}>{t('match.product')}</label>
              <select id={`fix-p-${s.id}`} className={selectClass} value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">{t('match.pickProduct')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className={fieldLabel} htmlFor={`fix-c-${s.id}`}>{t('money.filters.category')}</label>
              <CategorySelect id={`fix-c-${s.id}`} categories={categories} value={categoryId} onChange={setCategoryId} kind="expense" />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="accent" disabled={busy || (s.task === 'line_product' ? !productId : !categoryId)} onClick={() => void saveFix()}>
              {t('match.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFixing(false)}>{t('money.inbox.back')}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** "rule+ai1+ai2/split" → the i18n key that says it in words. */
export function patternKey(pattern: string): 'rule' | 'ruleAi' | 'ai' | 'agree' | 'split' | 'evidence' | 'history' {
  if (pattern.includes('/split')) return 'split';
  if (pattern === 'rule') return 'rule';
  if (pattern === 'evidence' || pattern === 'history') return pattern;
  if (pattern.startsWith('rule+')) return 'ruleAi';
  return pattern.split('+').length > 1 ? 'agree' : 'ai';
}
