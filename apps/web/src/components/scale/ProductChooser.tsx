// Pick the product a container holds: only weighable products (the stock unit converts to grams),
// with a filter box because a household has hundreds of products.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldLabel, selectClass, usePantry } from '@/components/pantry/bits';
import { Input } from '@/components/ui/input';
import { isWeighable } from '@/lib/scale/weighable';

export function ProductChooser({
  householdId,
  value,
  onChange,
  id,
  disabled,
}: {
  householdId: string;
  value: string | null;
  onChange: (productId: string | null) => void;
  id: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { products, units, conversions } = usePantry(householdId);
  const [filter, setFilter] = useState('');

  const options = useMemo(() => {
    if (!products.data || !units.data || !conversions.data) return [];
    const f = filter.trim().toLowerCase();
    return products.data.filter(
      (p) =>
        !p.archived &&
        isWeighable(p, units.data, conversions.data) &&
        (!f || p.id === value || p.name.toLowerCase().includes(f) || (p.name_si ?? '').includes(filter.trim())),
    );
  }, [products.data, units.data, conversions.data, filter, value]);

  return (
    <div className="flex flex-col gap-2">
      <label className={fieldLabel} htmlFor={id}>
        {t('scale.container.holds')}
      </label>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t('scale.container.filterProducts')}
        aria-label={t('scale.container.filterProducts')}
        disabled={disabled}
      />
      <select
        id={id}
        className={selectClass}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t('scale.container.nothing')}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <p className="text-[12px] text-faint">{t('scale.container.weighableHint')}</p>
    </div>
  );
}
