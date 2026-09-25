import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Box, ChevronLeft, Package, PackagePlus, Pencil, Trash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AccountDot, Money, TypeBadge, signedTotal } from '@/components/money/bits';
import { TransactionForm } from '@/components/money/TransactionForm';
import { useMoneyBasics } from '@/components/money/useMoney';
import { SendToPantry } from '@/components/spine/SendToPantry';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { categoryLabel, topOf } from '@/lib/money/categoriesMap';
import { formatLKR } from '@/lib/money/format';
import {
  deleteTransaction,
  invalidateMoney,
  moneyErrorKey,
  transactionQuery,
  unitsQuery,
  type Line,
} from '@/lib/money/queries';
import { invalidatePantry } from '@/lib/pantry/queries';
import { invalidateShopping, lineRoutesQuery } from '@/lib/spine/queries';
import { formatDay, todayIn } from '@/lib/time';
import { scheduleUndoableDelete } from '@/lib/undo';

export const Route = createFileRoute('/_app/money/tx/$txId')({
  component: TransactionPage,
});

// Rs per base unit is stored per g / ml; people think in kg / L.
function unitPrice(l: Line, unitCode: string | undefined): string | null {
  if (l.price_per_base == null || !unitCode) return null;
  if (unitCode === 'g' || unitCode === 'kg') return `${formatLKR(l.price_per_base * 1000)} / kg`;
  if (unitCode === 'ml' || unitCode === 'L') return `${formatLKR(l.price_per_base * 1000)} / L`;
  return `${formatLKR(l.price_per_base)} / ${unitCode}`;
}

function TransactionPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const { txId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const { accounts, categories, merchants } = useMoneyBasics(householdId);
  const q = useQuery(transactionQuery(householdId, txId));
  const units = useQuery(unitsQuery);
  const routes = useQuery(lineRoutesQuery(householdId, txId));
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);

  const back = () => (router.history.length > 1 ? router.history.back() : void navigate({ to: '/money' }));

  if (q.isPending || !accounts.data || !categories.data) {
    return <div className="glass h-64 animate-pulse rounded-[var(--r)]" aria-hidden />;
  }
  const tx = q.data?.tx;
  if (!tx) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-[15px]">{t('money.detail.notFound')}</p>
        <Link to="/money" className="text-accent-b underline">
          {t('money.detail.backToMoney')}
        </Link>
      </Card>
    );
  }
  const fee = q.data?.fee ?? null;
  const account = accounts.data.find((a) => a.id === tx.account_id);
  const to = accounts.data.find((a) => a.id === tx.to_account_id);
  const title =
    tx.type === 'transfer'
      ? t('money.list.transfer', { from: account?.name ?? '?', to: to?.name ?? '?' })
      : tx.payee_text || tx.lines[0]?.raw_name || t(`money.types.${tx.type as 'expense'}`);

  const refreshAll = () => {
    void invalidateMoney(qc, householdId);
    void invalidatePantry(qc, householdId);
    void invalidateShopping(qc, householdId);
  };

  // Lines that can still go to the pantry: bought items (not discounts) without stock yet.
  const unrouted = tx.type === 'expense' ? tx.lines.filter((l) => l.amount > 0 && !(routes.data?.get(l.id)?.lots ?? 0)) : [];

  function remove() {
    const id = tx!.id;
    const { undo, ms } = scheduleUndoableDelete({
      id,
      hide: () => {
        qc.removeQueries({ queryKey: ['money', householdId, 'tx', id] });
        void invalidateMoney(qc, householdId);
        back();
      },
      // The bill's pantry stock goes with it, unless some has been used (GDUSE) → offer to keep it.
      commit: () => deleteTransaction(id),
      restore: refreshAll,
      onError: (e) => {
        if (moneyErrorKey(e) !== 'stockUsed') return void toast.error(t(`money.errors.${moneyErrorKey(e)}`));
        toast.error(t('money.errors.stockUsed'), {
          duration: 15_000,
          action: {
            label: t('spine.deleteKeepStock'),
            onClick: () => {
              deleteTransaction(id, true)
                .then(() => toast.success(t('money.detail.deleted', { amount: formatLKR(tx!.total) })))
                .catch((err: unknown) => toast.error(t(`money.errors.${moneyErrorKey(err)}`)))
                .finally(refreshAll);
            },
          },
        });
      },
    });
    toast(t('money.detail.deleted', { amount: formatLKR(tx!.total) }), {
      duration: ms,
      action: { label: t('common.undo'), onClick: undo },
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={back} className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('common.back')}
      </button>

      <Card className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          {account && <AccountDot account={account} className="h-11 w-11" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[22px] leading-tight font-semibold">{title}</h1>
              <TypeBadge type={tx.type} />
            </div>
            <p className="tabular mt-1 text-[13px] text-muted">
              {[formatDay(tx.occurred_on, locale, todayIn(timezone).slice(0, 4)), tx.occurred_at?.slice(0, 5)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <Money
          value={tx.type === 'transfer' ? tx.total : signedTotal(tx.type, tx.total)}
          tone
          className="text-[34px] font-semibold tracking-tight"
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
          <dt className="text-muted">{t(tx.type === 'transfer' ? 'money.form.from' : 'money.detail.account')}</dt>
          <dd>
            <Link to="/money/accounts/$accountId" params={{ accountId: tx.account_id }} className="hover:underline">
              {account?.name}
            </Link>
          </dd>
          {to && (
            <>
              <dt className="text-muted">{t('money.form.to')}</dt>
              <dd>{to.name}</dd>
            </>
          )}
          {fee && (
            <>
              <dt className="text-muted">{t('money.form.fee')}</dt>
              <dd>
                <Money value={fee.total} />
              </dd>
            </>
          )}
          {tx.invoice_no && (
            <>
              <dt className="text-muted">{t('money.form.invoice')}</dt>
              <dd className="tabular">{tx.invoice_no}</dd>
            </>
          )}
          {tx.notes && (
            <>
              <dt className="text-muted">{t('money.form.notes')}</dt>
              <dd className="whitespace-pre-line">{tx.notes}</dd>
            </>
          )}
          <dt className="text-muted">{t('money.detail.source')}</dt>
          <dd>{t(`money.sources.${tx.source as 'manual'}`)}</dd>
        </dl>
      </Card>

      {tx.lines.length > 0 && (
        <Card className="p-0">
          <h2 className="px-5 pt-4 pb-2 font-display text-[17px] font-semibold">
            {t('money.detail.lines', { count: tx.lines.length })}
          </h2>
          <ul className="divide-y divide-line">
            {tx.lines.map((l) => {
              const top = topOf(categories.data, l.category_id);
              const per = unitPrice(l, l.unit_id ? units.data?.get(l.unit_id) : undefined);
              return (
                <li key={l.id} className="flex items-center gap-3 px-5 py-3">
                  <span aria-hidden className="w-6 shrink-0 text-center text-[17px]">
                    {top?.icon ?? '•'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{l.raw_name}</div>
                    <div className="truncate text-[12.5px] text-muted">
                      {[
                        categoryLabel(categories.data, l.category_id),
                        l.qty != null ? `${l.qty} ${l.unit_text ?? ''}`.trim() : null,
                        per,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <LineDestination line={l} route={routes.data?.get(l.id)} />
                  </div>
                  <Money value={l.amount} className="text-[14.5px]" />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {canWrite && unrouted.some((l) => l.destiny === 'stock' || l.destiny === null) && (
        <Button onClick={() => setSending(true)} className="self-start">
          <PackagePlus className="h-4 w-4" aria-hidden />
          {t('spine.sendToPantry')}
        </Button>
      )}

      <p className="tabular px-1 text-[11.5px] break-all text-faint">
        {t('money.detail.fingerprint')}: {tx.fingerprint}
      </p>

      {canWrite && (
        <div className="flex gap-2.5">
          {tx.type !== 'adjustment' && (
            <Button className="flex-1" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              {t('money.detail.edit')}
            </Button>
          )}
          <Button variant="destructive" className="flex-1" onClick={remove}>
            <Trash className="h-4 w-4" aria-hidden />
            {t('money.detail.delete')}
          </Button>
        </div>
      )}

      <TransactionForm
        open={editing}
        onClose={() => setEditing(false)}
        householdId={householdId}
        timezone={timezone}
        accounts={accounts.data}
        categories={categories.data}
        merchants={merchants.data ?? []}
        editing={{ tx, fee }}
      />

      {sending && (
        <SendToPantry
          householdId={householdId}
          transactionId={tx.id}
          lines={unrouted}
          onClose={() => setSending(false)}
        />
      )}
    </div>
  );
}

/** Where a line went: pantry stock (with a link), Things (Phase 5), or — for stock lines — not yet. */
function LineDestination({
  line,
  route,
}: {
  line: Line;
  route: { lots: number | null; product_id: string | null; product_name: string | null } | undefined;
}) {
  const { t } = useTranslation();
  if (route?.lots && route.product_id) {
    return (
      <Link
        to="/pantry/$productId"
        params={{ productId: route.product_id }}
        className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-teal/15 px-2.5 py-0.5 text-[12px] font-medium text-teal"
      >
        <Package className="h-3.5 w-3.5" aria-hidden />
        {t('spine.inPantry', { name: route.product_name ?? '' })}
      </Link>
    );
  }
  if (line.destiny === 'asset') {
    return (
      <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 py-0.5 text-[12px] text-[#c5cce3]">
        <Box className="h-3.5 w-3.5" aria-hidden />
        {t('spine.thingsLater')}
      </span>
    );
  }
  return null;
}
