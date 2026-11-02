import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowLeftRight, BellOff, Check, ChevronLeft, History, Link2, Package, Tag, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { AutoKind } from '@match/book';
import { EmptyState } from '@/components/aurora/EmptyState';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { autobookQuery, autobookSeen, byRun, undoAutobook, type AutoBooking } from '@/lib/match/autobook';
import { formatLKR } from '@/lib/money/format';
import { attentionKey } from '@/lib/insights/queries';
import { invalidateMoney } from '@/lib/money/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/money/changes')({
  component: ChangesPage,
});

const ICON: Record<AutoKind, typeof Link2> = {
  alert_link: Link2,
  alert_transfer: ArrowLeftRight,
  alert_note: BellOff,
  category_evidence: Tag,
  category_rule: Tag,
  line_product: Package,
};

const open = (b: AutoBooking) => !b.undone_at && !b.reviewed_at;

/**
 * Money › What changed (Phase 9c): everything Gedara booked by itself, grouped by run. Each booking can
 * be undone in one tap (the alert or line waits again and is never booked by itself again) or marked
 * "Looks right"; runs with nothing left to look at fold away under "Earlier".
 */
function ChangesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const rows = useQuery(autobookQuery(householdId));
  const [busy, setBusy] = useState<string | null>(null);

  const runs = byRun(rows.data ?? []);
  const current = runs.filter((g) => g.items.some(open));
  const earlier = runs.filter((g) => !g.items.some(open)).slice(0, 20);

  async function act(key: string, fn: () => Promise<void>, done: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
    } catch {
      toast.error(t('changes.failed'));
    } finally {
      setBusy(null);
      // an undo changes entries, balances, the inbox and Attention
      void invalidateMoney(qc, householdId);
      void qc.invalidateQueries({ queryKey: attentionKey(householdId) });
    }
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const runCard = (g: (typeof runs)[number], folded: boolean) => {
    const waiting = g.items.filter(open);
    return (
      <Card key={g.key} className={cn('flex flex-col gap-3', folded && 'opacity-80')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="min-w-0 flex-1 font-display text-[16.5px] font-semibold">
            <span className="tabular">{when(g.at)}</span>
            <span className="text-muted"> · {t('changes.booked', { count: g.items.length })}</span>
          </h2>
          {canWrite && waiting.length > 1 && (
            <Button size="sm" variant="secondary" disabled={busy !== null}
              onClick={() => void act(g.key, () => autobookSeen(waiting.map((b) => b.id)), t('changes.allSeenDone'))}>
              <Check className="h-4 w-4" aria-hidden />
              {t('changes.allSeen')}
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-2">
          {g.items.map((b) => (
            <Row key={b.id} b={b} householdId={householdId} canWrite={canWrite} busy={busy !== null}
              onUndo={() => void act(b.id, () => undoAutobook(b.id), t('changes.undone'))}
              onSeen={() => void act(b.id, () => autobookSeen([b.id]), t('changes.seenDone'))} />
          ))}
        </ul>
      </Card>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/money" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('nav.money')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('changes.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('changes.intro')}</p>
      </div>

      {rows.isError ? (
        <Card className="text-[14px] text-red">{t('changes.loadFailed')}</Card>
      ) : !rows.data ? (
        <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : runs.length === 0 ? (
        <EmptyState icon={History} title={t('changes.emptyTitle')} body={t('changes.emptyBody')}
          action={<Link to="/settings/matching" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{t('changes.switches')}</Link>} />
      ) : (
        <>
          {current.length === 0 && <p className="text-[14px] text-muted">{t('changes.allLooked')}</p>}
          {current.map((g) => runCard(g, false))}
          {earlier.length > 0 && (
            <details className="flex flex-col gap-3">
              <summary className="cursor-pointer text-[14px] text-muted hover:text-text">{t('changes.earlier', { count: earlier.length })}</summary>
              <div className="mt-3 flex flex-col gap-3">{earlier.map((g) => runCard(g, true))}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Row({ b, householdId, canWrite, busy, onUndo, onSeen }: {
  b: AutoBooking; householdId: string; canWrite: boolean; busy: boolean; onUndo: () => void; onSeen: () => void;
}) {
  const { t } = useTranslation();
  const { accounts, categories } = useMoneyBasics(householdId);
  const Icon = ICON[b.kind];
  const s = b.summary;
  const account = (id: string | null | undefined) => (id ? accounts.data?.find((a) => a.id === id)?.name : undefined);
  const category = s.category_id ? categories.data?.find((c) => c.id === s.category_id)?.name : undefined;
  const where = [account(s.account_id), s.to_account_id ? `→ ${account(s.to_account_id) ?? '—'}` : null, category,
    b.kind === 'line_product' && s.product ? `→ ${s.product}` : null].filter(Boolean).join(' ');

  return (
    <li className={cn('flex flex-col gap-2 rounded-2xl bg-white/[0.035] px-3 py-2.5 sm:flex-row sm:items-center', b.undone_at && 'opacity-60')}>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{s.payee ?? t(`changes.kinds.${b.kind}`)}</span>
            {s.amount != null && <span className="tabular font-mono text-[13.5px]">{formatLKR(Number(s.amount))}</span>}
          </div>
          <div className="text-[12.5px] text-muted">
            {t(`changes.kinds.${b.kind}`)}
            {where && <span> · {where}</span>}
          </div>
          {b.undone_at ? (
            <div className="text-[12px] text-faint">{t('changes.wasUndone')}</div>
          ) : b.reviewed_at ? (
            <div className="text-[12px] text-teal">{t('changes.looked')}</div>
          ) : null}
        </div>
      </div>
      {!b.undone_at && (
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          {b.transaction_id && (
            <Link to="/money/tx/$txId" params={{ txId: b.transaction_id }} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('changes.open')}
            </Link>
          )}
          {canWrite && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onUndo}>
              <Undo2 className="h-4 w-4" aria-hidden />
              {t('changes.undo')}
            </Button>
          )}
          {canWrite && !b.reviewed_at && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onSeen}>
              <Check className="h-4 w-4" aria-hidden />
              {t('changes.seen')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
