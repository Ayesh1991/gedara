import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UnitPrice } from '@/components/pantry/bits';
import { invalidatePantry, pantryErrorKey } from '@/lib/pantry/queries';
import type { Unit } from '@/lib/pantry/units';
import { aliasesQuery, forgetAlias, productPricesQuery } from '@/lib/spine/queries';
import { formatDay } from '@/lib/time';

/** Product page: Rs per kg by shop (§5.2) and the bill names that find this product (§4 row 1). */
export function ProductSpine({
  householdId,
  productId,
  unit,
  canWrite,
  locale,
  today,
}: {
  householdId: string;
  productId: string;
  unit: Unit | undefined;
  canWrite: boolean;
  locale: string;
  today: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const prices = useQuery(productPricesQuery(householdId, productId));
  const aliases = useQuery(aliasesQuery(householdId));
  const names = (aliases.data ?? []).filter((a) => a.product_id === productId).sort((a, b) => b.hits - a.hits);
  const cheapest = Math.min(...(prices.data ?? []).map((p) => p.last_unit_cost ?? Infinity));

  async function forget(id: string) {
    try {
      await forgetAlias(id);
      await invalidatePantry(qc, householdId);
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    }
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-[19px] font-semibold">{t('spine.pricesTitle')}</h2>
        {!prices.data?.length ? (
          <p className="text-[14px] text-[#a5b0d0]">{t('spine.pricesEmpty')}</p>
        ) : (
          <ul className="glass flex flex-col divide-y divide-line rounded-2xl" data-testid="prices">
            {prices.data.map((p) => (
              <li key={p.merchant_id ?? 'none'} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px]">{p.merchant_name ?? t('spine.unknownShop')}</div>
                  <div className="tabular text-[12.5px] text-muted">
                    {t('spine.pricesLine', {
                      count: p.times ?? 0,
                      date: p.last_bought_on ? formatDay(p.last_bought_on, locale, today.slice(0, 4)) : '',
                    })}
                  </div>
                </div>
                <UnitPrice
                  unitCost={p.last_unit_cost}
                  unit={unit}
                  className={p.last_unit_cost === cheapest && (prices.data?.length ?? 0) > 1 ? 'text-teal' : 'text-[14px]'}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-[19px] font-semibold">{t('spine.namesTitle')}</h2>
        {names.length === 0 ? (
          <p className="text-[14px] text-[#a5b0d0]">{t('spine.namesEmpty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-testid="bill-names">
            {names.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1 rounded-full bg-white/[0.07] py-1 pr-1 pl-3 text-[13px]">
                <span className="tabular">{a.alias_norm}</span>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => void forget(a.id)}
                    aria-label={t('spine.forgetName', { name: a.alias_norm })}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-text"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
