import { useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Archive, ArchiveRestore, ChevronLeft, Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/money/bits';
import { useMoneyBasics } from '@/components/money/useMoney';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { subsOf, type CategoryRow } from '@/lib/money/categoriesMap';
import { createCategory, invalidateMoney, moneyErrorKey, updateCategory } from '@/lib/money/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/categories')({
  component: CategoriesPage,
});

type Editing = { mode: 'add'; parent: CategoryRow } | { mode: 'edit'; category: CategoryRow };

/** Categories: the ledger v7 set + Income. Add sub-categories, rename, recolour, archive. */
function CategoriesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const { categories } = useMoneyBasics(householdId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const cats = categories.data ?? [];
  const tops = cats.filter((c) => c.parent_id === null).sort((a, b) => a.sort - b.sort);

  async function toggleArchive(c: CategoryRow) {
    try {
      await updateCategory(c.id, { archived: !c.archived });
      await invalidateMoney(qc, householdId);
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('categories.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('categories.intro')}</p>
      </div>

      {categories.isPending ? (
        <div className="glass h-64 animate-pulse rounded-[var(--r)]" aria-hidden />
      ) : (
        tops.map((top) => (
          <Card key={top.id} className={cn('flex flex-col gap-3', top.archived && 'opacity-60')}>
            <div className="flex items-center gap-3">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[18px]"
                style={{ background: `color-mix(in srgb, ${top.color ?? 'var(--accent-a)'} 20%, transparent)` }}
                aria-hidden
              >
                {top.icon}
              </span>
              <h2 className="flex-1 font-display text-[17px] font-semibold">{top.name}</h2>
              {canWrite && (
                <Button variant="ghost" size="icon" aria-label={t('categories.edit', { name: top.name })} onClick={() => setEditing({ mode: 'edit', category: top })}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
            <ul className="flex flex-wrap gap-2">
              {subsOf(cats, top.id).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => setEditing({ mode: 'edit', category: s })}
                    className={cn(
                      'rounded-full border border-line-2 bg-white/5 px-3 py-1.5 text-[13.5px] hover:border-white/25',
                      s.archived && 'text-faint line-through',
                    )}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
              {canWrite && (
                <li>
                  <button
                    type="button"
                    onClick={() => setEditing({ mode: 'add', parent: top })}
                    className="flex items-center gap-1 rounded-full border border-dashed border-line-2 px-3 py-1.5 text-[13.5px] text-muted hover:text-text"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    {t('categories.addSub')}
                  </button>
                </li>
              )}
            </ul>
          </Card>
        ))
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing?.mode === 'add'
            ? t('categories.addIn', { name: editing.parent.name })
            : t('categories.edit', { name: editing?.category.name ?? '' })
        }
      >
        {editing && (
          <CategoryForm
            editing={editing}
            householdId={householdId}
            onDone={() => setEditing(null)}
            onArchive={(c) => {
              void toggleArchive(c);
              setEditing(null);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function CategoryForm({
  editing,
  householdId,
  onDone,
  onArchive,
}: {
  editing: Editing;
  householdId: string;
  onDone: () => void;
  onArchive: (c: CategoryRow) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const cat = editing.mode === 'edit' ? editing.category : null;
  const isTop = cat?.parent_id === null;
  const [name, setName] = useState(cat?.name ?? '');
  const [icon, setIcon] = useState(cat?.icon ?? '');
  const [color, setColor] = useState(cat?.color ?? '#8B5CF6');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (editing.mode === 'add') await createCategory(householdId, editing.parent.id, name);
      else await updateCategory(editing.category.id, isTop ? { name: name.trim(), icon: icon || null, color } : { name: name.trim() });
      await invalidateMoney(qc, householdId);
      onDone();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="cat-name" className={fieldLabel}>
          {t('categories.name')}
        </label>
        <Input id="cat-name" autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {isTop && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="cat-icon" className={fieldLabel}>
              {t('categories.icon')}
            </label>
            <Input id="cat-icon" maxLength={8} value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <div>
            <label htmlFor="cat-color" className={fieldLabel}>
              {t('categories.color')}
            </label>
            <Input id="cat-color" type="color" className="p-1.5" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
        </div>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {t('categories.save')}
      </Button>
      {cat && (
        <Button variant="ghost" onClick={() => onArchive(cat)}>
          {cat.archived ? <ArchiveRestore className="h-4 w-4" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />}
          {t(cat.archived ? 'categories.unarchive' : 'categories.archive')}
        </Button>
      )}
    </form>
  );
}
