// "In containers" on a product's page (Phase 6b): the jars that hold it, whether they are ready for the
// kitchen scale (tag + empty weight), linking to each jar's page.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Scale, Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatGrams } from '@/lib/scale/format';
import { productContainersQuery } from '@/lib/scale/queries';

export function ProductContainers({ householdId, productId }: { householdId: string; productId: string }) {
  const { t } = useTranslation();
  const jars = useQuery(productContainersQuery(householdId, productId));
  if (!jars.data?.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-[19px] font-semibold">{t('scale.product.title')}</h2>
      <ul className="glass divide-y divide-line overflow-hidden rounded-[var(--r)]">
        {jars.data.map((j) => (
          <li key={j.id}>
            <Link to="/places/$placeId" params={{ placeId: j.id }} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]">
              <Scale className="h-5 w-5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{j.path}</span>
              <span className="tabular text-[12.5px] text-muted">
                {j.tare_g !== null ? t('scale.product.empty', { tare: formatGrams(j.tare_g) }) : t('scale.product.noTare')}
              </span>
              <Tag className={`h-4 w-4 ${j.tag ? 'text-teal' : 'text-faint'}`} aria-label={t(j.tag ? 'scale.product.tagged' : 'scale.product.untagged')} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
