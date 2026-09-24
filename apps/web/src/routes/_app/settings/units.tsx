import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel, selectClass } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createUnit, deleteUnit, invalidatePantry, pantryErrorKey, pantryUnitsQuery } from '@/lib/pantry/queries';
import { parseQty, type Unit } from '@/lib/pantry/units';

export const Route = createFileRoute('/_app/settings/units')({
  component: UnitsPage,
});

const DIMENSIONS = ['other', 'mass', 'volume', 'count', 'length', 'energy'] as const;
type Dim = (typeof DIMENSIONS)[number];
const BASE: Record<Dim, string> = { other: '', mass: 'g', volume: 'ml', count: 'pcs', length: 'm', energy: 'kWh' };

/** Units: the built-in ones (read-only) and the household's own ("tin", "sachet", "dozen" = 12 pcs). */
function UnitsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const units = useQuery(pantryUnitsQuery(householdId));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dimension, setDimension] = useState<Dim>('other');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);

  const all = [...(units.data?.values() ?? [])];
  const system = all.filter((u) => u.household_id === null);
  const own = all.filter((u) => u.household_id !== null).sort((a, b) => a.code.localeCompare(b.code));
  const toBase = dimension === 'other' ? 1 : parseQty(size);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || !toBase || busy) return;
    setBusy(true);
    try {
      await createUnit(householdId, {
        code: code.trim(),
        name: name.trim() || code.trim(),
        dimension,
        to_base: toBase,
        aliases: [],
      });
      await invalidatePantry(qc, householdId);
      toast.success(t('units.added', { code: code.trim() }));
      setCode('');
      setName('');
      setSize('');
    } catch (err) {
      toast.error(t(`pantry.errors.${pantryErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: Unit) {
    try {
      await deleteUnit(u.id);
      await invalidatePantry(qc, householdId);
      toast.success(t('units.deleted', { code: u.code }));
    } catch (err) {
      toast.error(pantryErrorKey(err) === 'reference' ? t('units.inUse') : t(`pantry.errors.${pantryErrorKey(err)}`));
    }
  }

  const describe = (u: Unit) =>
    u.dimension === 'other' || u.to_base === 1 ? t(`units.dimensions.${u.dimension as Dim}`) : `= ${u.to_base} ${BASE[u.dimension as Dim] ?? ''}`;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('units.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('units.intro')}</p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-[17px] font-semibold">{t('units.own')}</h2>
        {own.length === 0 ? (
          <p className="text-[14px] text-[#a5b0d0]">{t('units.ownEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {own.map((u) => (
              <li key={u.id} className="flex items-center gap-3 text-[14.5px]">
                <span className="tabular w-20 shrink-0">{u.code}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {u.name} · {describe(u)}
                </span>
                {canWrite && (
                  <button
                    type="button"
                    aria-label={t('units.delete', { code: u.code })}
                    onClick={() => void remove(u)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <form onSubmit={submit} className="mt-2 flex flex-col gap-3 border-t border-line pt-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="unit-code" className={fieldLabel}>
                  {t('units.code')}
                </label>
                <Input id="unit-code" value={code} maxLength={16} placeholder="tin" onChange={(e) => setCode(e.target.value)} />
              </div>
              <div>
                <label htmlFor="unit-name" className={fieldLabel}>
                  {t('units.name')}
                </label>
                <Input id="unit-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="unit-dimension" className={fieldLabel}>
                  {t('units.dimension')}
                </label>
                <select id="unit-dimension" className={selectClass} value={dimension} onChange={(e) => setDimension(e.target.value as Dim)}>
                  {DIMENSIONS.map((d) => (
                    <option key={d} value={d}>
                      {t(`units.dimensions.${d}`)}
                    </option>
                  ))}
                </select>
              </div>
              {dimension !== 'other' && (
                <div>
                  <label htmlFor="unit-size" className={fieldLabel}>
                    {t('units.size', { base: BASE[dimension] })}
                  </label>
                  <Input id="unit-size" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} className="tabular" />
                </div>
              )}
            </div>
            <p className="text-[12.5px] text-muted">{t('units.hint')}</p>
            <Button type="submit" variant="primary" disabled={busy || !code.trim() || !toBase}>
              {t('units.add')}
            </Button>
          </form>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="font-display text-[17px] font-semibold">{t('units.system')}</h2>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {system.map((u) => (
            <li key={u.id} className="flex gap-2 text-[14px]">
              <span className="tabular w-14 shrink-0">{u.code}</span>
              <span className="truncate text-muted">{u.name}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
