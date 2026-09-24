import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, CircleCheck, MessageSquareText, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState } from '@/components/aurora/EmptyState';
import { Money } from '@/components/money/bits';
import { SmsCard, applyConfident, type CardItem } from '@/components/money/SmsCard';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { invalidateMoney, moneyErrorKey } from '@/lib/money/queries';
import { analyseInbox, smsSigned } from '@/lib/sms/match';
import { smsCandidatesQuery, smsIgnore, smsQuery, smsUnlink, type InboxRow } from '@/lib/sms/queries';
import { supabase } from '@/lib/supabase';
import { formatDay, todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

const SearchSchema = z.object({ view: z.enum(['new', 'reviewed']).optional() });

export const Route = createFileRoute('/_app/money/inbox')({
  validateSearch: SearchSchema,
  component: InboxPage,
});

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function InboxPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/money/inbox' });
  const { view = 'new' } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const [accepting, setAccepting] = useState<{ done: number; total: number } | null>(null);

  const { accounts, categories } = useMoneyBasics(householdId);
  const sms = useQuery(smsQuery(householdId));
  const fresh = useMemo(() => (sms.data ?? []).filter((s) => !s.ignored && !s.transaction_id), [sms.data]);
  const reviewed = useMemo(
    () =>
      (sms.data ?? [])
        .filter((s) => s.ignored || s.transaction_id)
        .sort((a, b) => (b.reviewed_at ?? b.received_at).localeCompare(a.reviewed_at ?? a.received_at))
        .slice(0, 100),
    [sms.data],
  );

  // Candidates: everything within ±7 days of the new alerts.
  const days = fresh.map((s) => s.occurred_on).sort();
  const from = days.length ? addDays(days[0]!, -7) : null;
  const to = days.length ? addDays(days.at(-1)!, 7) : null;
  const cands = useQuery(smsCandidatesQuery(householdId, from, to));

  // Live: a forwarded alert appears without a refresh (RLS applies to Realtime too).
  useEffect(() => {
    const channel = supabase
      .channel(`sms-inbox-${householdId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sms_message', filter: `household_id=eq.${householdId}` },
        () => void qc.invalidateQueries({ queryKey: smsQuery(householdId).queryKey }),
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [householdId, qc]);

  const linked = useMemo(
    () => new Set((sms.data ?? []).map((s) => s.transaction_id).filter((x): x is string => !!x)),
    [sms.data],
  );
  const openCandidates = useMemo(() => (cands.data ?? []).filter((c) => !linked.has(c.id)), [cands.data, linked]);

  const items = useMemo((): CardItem[] => {
    if (!sms.data || !accounts.data || (from && !cands.data)) return [];
    const a = analyseInbox(sms.data, cands.data ?? [], linked, accounts.data);
    const byId = new Map(fresh.map((s) => [s.id, s]));
    const used = new Set<string>();
    const out: CardItem[] = [];
    for (const s of fresh) {
      if (used.has(s.id)) continue;
      const sug = a.suggestions.get(s.id) ?? { kind: 'none' as const };
      const pair = sug.kind === 'transfer' && sug.pairId ? byId.get(sug.pairId) : undefined;
      used.add(s.id);
      if (pair) used.add(pair.id);
      out.push({
        rows: pair ? [s, pair] : [s],
        suggestion: sug,
        gap: a.gaps.get(s.id) ?? (pair ? a.gaps.get(pair.id) : undefined) ?? null,
        lkr: a.lkr.get(s.id) ?? { amount: s.amount, estimated: false },
      });
    }
    return out;
  }, [sms.data, accounts.data, cands.data, from, fresh, linked]);

  const confident = items.filter(
    (i) => (i.suggestion.kind === 'link' || i.suggestion.kind === 'transfer') && i.suggestion.confident,
  );

  const refresh = () => void invalidateMoney(qc, householdId);

  async function acceptAll() {
    if (accepting || !categories.data) return;
    setAccepting({ done: 0, total: confident.length });
    let ok = 0;
    let failed = 0;
    for (const item of confident) {
      try {
        if (await applyConfident(item, { householdId, categories: categories.data })) ok++;
      } catch {
        failed++;
      }
      setAccepting({ done: ok + failed, total: confident.length });
    }
    setAccepting(null);
    refresh();
    if (failed) toast.error(t('money.inbox.acceptedSome', { ok, failed }));
    else toast.success(t('money.inbox.accepted', { count: ok }));
  }

  // Group the new cards by day (newest first).
  const groups: Array<{ day: string; items: CardItem[] }> = [];
  for (const it of items) {
    const day = it.rows[0]!.occurred_on;
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(it);
    else groups.push({ day, items: [it] });
  }

  const loading = sms.isPending || accounts.isPending || categories.isPending || (!!from && cands.isPending);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/money" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.money')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('money.inbox.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('money.inbox.intro')}</p>
      </div>

      <div role="tablist" aria-label={t('money.inbox.title')} className="grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
        {(['new', 'reviewed'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={view === k}
            onClick={() => void navigate({ search: { view: k }, replace: true })}
            className={cn('h-11 rounded-xl font-display text-[14.5px] font-medium text-muted', view === k && 'accent-pill text-text')}
          >
            {k === 'new' ? t('money.inbox.newTab', { count: items.length || fresh.length }) : t('money.inbox.reviewedTab')}
          </button>
        ))}
      </div>

      {sms.isError ? (
        <Card className="text-[14px] text-muted">{t('money.loadError')}</Card>
      ) : loading ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : view === 'new' ? (
        items.length === 0 ? (
          <EmptyState
            icon={(sms.data?.length ?? 0) > 0 ? CircleCheck : MessageSquareText}
            title={(sms.data?.length ?? 0) > 0 ? t('money.inbox.allDone') : t('money.inbox.emptyTitle')}
            body={(sms.data?.length ?? 0) > 0 ? t('money.inbox.allDoneBody') : t('money.inbox.emptyBody')}
            action={
              (sms.data?.length ?? 0) === 0 && canWrite ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {membership.role === 'owner' && (
                    <Link to="/settings/devices" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                      {t('money.inbox.setUpPhone')}
                    </Link>
                  )}
                  <Link to="/money/import" search={{ tab: 'sms' }} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                    {t('money.inbox.importBackup')}
                  </Link>
                </div>
              ) : undefined
            }
          />
        ) : (
          <>
            {canWrite && confident.length > 0 && (
              <Button variant="primary" disabled={!!accepting} onClick={() => void acceptAll()}>
                <CircleCheck className="h-5 w-5" aria-hidden />
                {accepting
                  ? t('money.inbox.accepting', { done: accepting.done, total: accepting.total })
                  : t('money.inbox.acceptAll', { count: confident.length })}
              </Button>
            )}
            {groups.map(({ day, items: dayItems }) => (
              <section key={day} aria-label={formatDay(day, locale, today.slice(0, 4))}>
                <h2 className="tabular mb-2 px-1 text-[12.5px] tracking-wide text-muted uppercase">
                  {formatDay(day, locale, today.slice(0, 4))}
                </h2>
                <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
                  {dayItems.map((item) => (
                    <SmsCard
                      key={item.rows.map((r) => r.id).join('+')}
                      item={item}
                      householdId={householdId}
                      locale={locale}
                      today={today}
                      accounts={accounts.data ?? []}
                      categories={categories.data ?? []}
                      candidates={openCandidates}
                      canWrite={canWrite}
                      onDone={refresh}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )
      ) : reviewed.length === 0 ? (
        <Card className="text-[14px] text-muted">{t('money.inbox.nothingReviewed')}</Card>
      ) : (
        <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
          {reviewed.map((s) => (
            <ReviewedRow key={s.id} sms={s} locale={locale} today={today} canWrite={canWrite} onDone={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewedRow({
  sms,
  locale,
  today,
  canWrite,
  onDone,
}: {
  sms: InboxRow;
  locale: string;
  today: string;
  canWrite: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      if (sms.ignored) await smsIgnore([sms.id], false);
      else await smsUnlink([sms.id]);
      onDone();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-h-16 items-center gap-3 px-3.5 py-3 sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{sms.merchant_text || t(`money.inbox.kinds.${sms.kind as 'card_charge'}`)}</div>
        <div className="truncate text-[12.5px] text-muted">
          {[formatDay(sms.occurred_on, locale, today.slice(0, 4)), sms.ignored ? t('money.inbox.statusIgnored') : t('money.inbox.statusDone')]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {sms.amount !== null && sms.currency === 'LKR' && <Money value={smsSigned(sms, sms.amount)} className="text-[14px]" />}
      {sms.transaction_id && (
        <Link to="/money/tx/$txId" params={{ txId: sms.transaction_id }} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('money.inbox.open')}
        </Link>
      )}
      {canWrite && (
        <Button size="sm" variant="ghost" disabled={busy} aria-label={t('money.inbox.undo')} onClick={() => void undo()}>
          <Undo2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </li>
  );
}
