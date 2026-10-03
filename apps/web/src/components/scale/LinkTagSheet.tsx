// A tag the scale doesn't know (Phase 6b): link it to a container here — no Android phone needed. Pick
// an existing container, or make a new one (name + what it holds). If the jar on the scale is empty
// right now, its weight becomes the container's empty weight in the same step.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel, selectClass } from '@/components/pantry/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { formatGrams } from '@/lib/scale/format';
import { containersQuery, invalidateScale, linkTag, scaleErrorKey, setContainer } from '@/lib/scale/queries';
import type { TablesInsert } from '@/lib/db.types';
import { supabase } from '@/lib/supabase';
import { ProductChooser } from './ProductChooser';

export function LinkTagSheet({
  open,
  onClose,
  householdId,
  uid,
  grossG,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  uid: string;
  grossG: number | null;
  onLinked: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const containers = useQuery(containersQuery(householdId));
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [emptyNow, setEmptyNow] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = containers.data ?? [];
  const chosen = list.find((c) => c.id === locationId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      let target = locationId;
      if (mode === 'new') {
        const { data, error } = await supabase
          .from('location')
          // code and path come from triggers (same cast as lib/places.ts createPlace).
          .insert({ household_id: householdId, name: name.trim(), kind: 'container', holds_product_id: productId } as TablesInsert<'location'>)
          .select('id')
          .single();
        if (error) throw error;
        target = data.id;
      }
      if (!target) return;
      await linkTag(target, uid);
      if (emptyNow && grossG !== null && grossG >= 0) await setContainer(target, { tare_g: Math.round(grossG * 10) / 10 });
      toast.success(t('scale.link.done'));
      await invalidateScale(qc, householdId);
      onLinked();
    } catch (err) {
      toast.error(t(`scale.errors.${scaleErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('scale.link.title')}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <p className="text-[14px] text-muted">{t('scale.link.intro', { uid })}</p>
        <div className="flex gap-2" role="radiogroup" aria-label={t('scale.link.title')}>
          {(['existing', 'new'] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? 'accent' : 'secondary'}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
            >
              {t(`scale.link.${m}`)}
            </Button>
          ))}
        </div>

        {mode === 'existing' ? (
          <div>
            <label className={fieldLabel} htmlFor="link-container">
              {t('scale.link.container')}
            </label>
            <select
              id="link-container"
              className={selectClass}
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              required
            >
              <option value="">{t('scale.link.pick')}</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                  {c.product ? ` — ${c.product.name}` : ''}
                  {c.tag ? ` · ${t('scale.link.hasTag')}` : ''}
                </option>
              ))}
            </select>
            {chosen?.tag && <p className="mt-1.5 text-[12.5px] text-caution">{t('scale.link.replaces')}</p>}
          </div>
        ) : (
          <>
            <div>
              <label className={fieldLabel} htmlFor="link-name">
                {t('scale.link.name')}
              </label>
              <Input
                id="link-name"
                value={name}
                maxLength={80}
                required
                placeholder={t('scale.link.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <ProductChooser householdId={householdId} id="link-product" value={productId} onChange={setProductId} />
          </>
        )}

        {grossG !== null && grossG >= 0 && (
          <label className="flex items-start gap-3 text-[14px]">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--accent-a)]"
              checked={emptyNow}
              onChange={(e) => setEmptyNow(e.target.checked)}
            />
            <span>{t('scale.link.emptyNow', { gross: formatGrams(grossG) })}</span>
          </label>
        )}

        <Button type="submit" variant="primary" disabled={busy || (mode === 'existing' ? !locationId : !name.trim())}>
          {t('scale.link.save')}
        </Button>
      </form>
    </Sheet>
  );
}
