import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import { createCategory, invalidateMoney, moneyErrorKey } from '@/lib/money/queries';
import { cn } from '@/lib/utils';

/**
 * "+ New category…" from any category picker (Phase 7d): a sub-category under one of the main
 * categories, saved and picked at once. The same rules as Settings › Categories. No <form>: it opens
 * on top of the form that holds the picker.
 */
export function NewCategorySheet({
  open,
  onClose,
  householdId,
  tops,
  defaultParentId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  /** The main categories this picker offers (expense or income). */
  tops: CategoryRow[];
  defaultParentId: string | null;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [parentId, setParentId] = useState(defaultParentId ?? tops[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || !parentId || busy) return;
    setBusy(true);
    try {
      const id = await createCategory(householdId, parentId, name);
      await invalidateMoney(qc, householdId);
      toast.success(t('categories.createdInline', { name: name.trim() }));
      onCreated(id);
      onClose();
    } catch (e) {
      toast.error(t(`money.errors.${moneyErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('categories.newInline')}>
      {open && (
        <div className="flex flex-col gap-4" data-testid="new-category-sheet">
          <div>
            <label htmlFor="new-cat-parent" className="mb-1.5 block text-[13px] font-medium text-muted">
              {t('categories.under')}
            </label>
            <select
              id="new-cat-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="h-12 w-full rounded-[14px] border border-line-2 bg-[#0d1326] px-3.5 text-[16px] text-text focus:border-accent-a focus:outline-none"
            >
              {tops.map((top) => (
                <option key={top.id} value={top.id}>
                  {`${top.icon ?? ''} ${top.name}`.trim()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-cat-name" className="mb-1.5 block text-[13px] font-medium text-muted">
              {t('categories.name')}
            </label>
            <Input
              id="new-cat-name"
              autoFocus
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault(); // don't submit the form underneath
                void save();
              }}
              autoComplete="off"
            />
          </div>
          <Button variant="primary" disabled={busy || !name.trim() || !parentId} onClick={() => void save()} className={cn('w-full')}>
            {busy ? t('common.saving') : t('categories.createAndPick')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
