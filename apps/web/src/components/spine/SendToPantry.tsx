import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { invalidateMoney, moneyErrorKey, type Line } from '@/lib/money/queries';
import { invalidatePantry, undoStock } from '@/lib/pantry/queries';
import { invalidateShopping, routeLines } from '@/lib/spine/queries';
import { isBlocking, isUnresolved, routeProblem, toRpcRoute, type LineRoute } from '@/lib/spine/route';
import { UNDO_MS } from '@/lib/undo';
import { BillRouter, effectiveRoute, previewFor } from './BillRouter';
import { categoryDestiny, useProposals, useSpineData, type RouterLine } from './useSpine';

/**
 * "Send to pantry" for a bill that's already in Gedara (an SMS / manual entry, or one imported
 * before its products existed): the same line routing as the import, applied with rpc_route_lines.
 */
export function SendToPantry({
  householdId,
  transactionId,
  lines,
  onClose,
}: {
  householdId: string;
  transactionId: string;
  lines: Line[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const data = useSpineData(householdId);
  const [overrides, setOverrides] = useState<Record<string, LineRoute>>({});
  const [busy, setBusy] = useState(false);

  const routerLines = useMemo(
    () =>
      lines.map(
        (l): RouterLine => ({
          key: l.id,
          raw_name: l.raw_name,
          amount: l.amount,
          qty: l.qty,
          unitId: l.unit_id,
          // Scanned bills without a unit were saved as 'pcs': treat that as "no unit printed".
          unitMissing: !l.unit_text || l.unit_text.toLowerCase() === 'pcs',
          category_id: l.category_id,
        }),
      ),
    [lines],
  );
  const proposals = useProposals(routerLines, data);
  const routes = new Map<string, LineRoute>();
  for (const l of routerLines) {
    const r = overrides[l.key] ?? proposals.get(l.key);
    if (r) routes.set(l.key, effectiveRoute(r, l, data.products.data));
  }
  const problems = routerLines.filter((l) => {
    const r = routes.get(l.key);
    return r && isBlocking(routeProblem(r, previewFor(r, l, data)));
  }).length;
  const stock = [...routes.values()].filter((r) => r.destiny === 'stock' && !isUnresolved(r)).length;

  async function send() {
    if (busy || problems > 0 || !data.ready || !data.categories.data) return;
    setBusy(true);
    try {
      const payload = routerLines
        .filter((l) => routes.has(l.key) && !isUnresolved(routes.get(l.key)!))
        .map((l) => ({ line_id: l.key, ...toRpcRoute(routes.get(l.key)!, categoryDestiny(data.categories.data!, l.category_id)) }));
      const r = await routeLines(transactionId, payload);
      const refresh = () =>
        Promise.all([invalidateMoney(qc, householdId), invalidatePantry(qc, householdId), invalidateShopping(qc, householdId)]);
      await refresh();
      const correlation = r.correlation_id;
      toast.success(
        [t('spine.lotsAdded', { count: r.lots }), r.ticked ? t('spine.ticked', { count: r.ticked }) : null].filter(Boolean).join(' · '),
        {
          duration: UNDO_MS,
          action: correlation
            ? {
                label: t('common.undo'),
                onClick: () =>
                  void undoStock(correlation)
                    .then(refresh)
                    .then(() => toast(t('pantry.done.undone')))
                    .catch((e: unknown) => toast.error(t(`money.errors.${moneyErrorKey(e)}`))),
              }
            : undefined,
        },
      );
      onClose();
    } catch (e) {
      toast.error(t(`money.errors.${moneyErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={t('spine.sendTitle')}>
      <p className="text-[14px] text-muted">{t('spine.sendHelp')}</p>
      {data.ready ? (
        <BillRouter
          lines={routerLines}
          routes={routes}
          data={data}
          onRoute={(key, r) => setOverrides((o) => ({ ...o, [key]: r }))}
        />
      ) : (
        <div className="glass h-32 animate-pulse rounded-2xl" aria-hidden />
      )}
      <Button variant="primary" className="w-full" disabled={busy || problems > 0 || stock === 0 || !data.ready} onClick={() => void send()}>
        {problems > 0 ? t('spine.fix', { count: problems }) : t('spine.sendConfirm', { count: stock })}
      </Button>
    </Sheet>
  );
}
