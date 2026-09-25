import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CategorySelect, fieldLabel, selectClass } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { categoryLabel } from '@/lib/money/categoriesMap';
import { categoriesQuery } from '@/lib/money/queries';
import { FIELD_TYPES, fieldKey, fieldsFor, type FieldType } from '@/lib/things/fields';
import { createField, deleteField, fieldsQuery, invalidateThings, thingsErrorKey, updateField } from '@/lib/things/queries';

export const Route = createFileRoute('/_app/settings/fields')({
  component: FieldsPage,
});

/** Settings › Fields for things: extra fields per category ("Electronics" → IMEI, storage …; §3.5). */
function FieldsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const householdId = membership.household.id;
  const canWrite = membership.role !== 'viewer';
  const categories = useQuery(categoriesQuery(householdId));
  const fields = useQuery(fieldsQuery(householdId));
  const cats = useMemo(() => categories.data ?? [], [categories.data]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [busy, setBusy] = useState(false);

  const all = fields.data ?? [];
  const own = all.filter((f) => f.category_id === categoryId).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  const inherited = fieldsFor(all, categoryId, cats).filter((f) => f.category_id !== categoryId);
  const withFields = [...new Set(all.map((f) => f.category_id))];

  async function act(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    try {
      await fn();
      await invalidateThings(qc, householdId);
      done?.();
    } catch (e) {
      toast.error(t(`things.errors.${thingsErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!categoryId || !label.trim()) return;
    const opts = type === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : null;
    if (type === 'select' && !opts?.length) {
      toast.error(t('fields.needOptions'));
      return;
    }
    void act(
      () =>
        createField(householdId, {
          category_id: categoryId,
          key: fieldKey(label),
          label: label.trim(),
          type,
          options: opts,
          sort: (own.at(-1)?.sort ?? 0) + 1,
        }),
      () => {
        setLabel('');
        setOptions('');
        toast.success(t('fields.added', { label: label.trim() }));
      },
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/settings" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('settings.title')}
        </Link>
        <h1 className="mt-1 font-display text-[30px] font-semibold tracking-tight">{t('fields.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('fields.intro')}</p>
      </div>

      {withFields.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {withFields.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={categoryId === id}
              onClick={() => setCategoryId(id)}
              className={categoryId === id ? 'accent-pill h-9 rounded-full px-3.5 text-[13px]' : 'glass h-9 rounded-full px-3.5 text-[13px] text-muted'}
            >
              {categoryLabel(cats, id)}
            </button>
          ))}
        </div>
      )}

      <Card className="flex flex-col gap-4">
        <div>
          <label htmlFor="fields-category" className={fieldLabel}>
            {t('fields.category')}
          </label>
          <CategorySelect id="fields-category" categories={cats} value={categoryId} onChange={setCategoryId} kind="expense" />
        </div>

        {categoryId && (
          <>
            {inherited.length > 0 && (
              <p className="text-[13px] text-muted">{t('fields.inherited', { names: inherited.map((f) => f.label).join(', ') })}</p>
            )}
            {own.length === 0 ? (
              <p className="text-[14px] text-[#a5b0d0]">{t('fields.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5" data-testid="fields">
                {own.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                    <Input
                      aria-label={t('fields.label')}
                      defaultValue={f.label}
                      disabled={!canWrite}
                      maxLength={60}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== f.label) void act(() => updateField(f.id, { label: v }));
                      }}
                      className="h-10 flex-1"
                    />
                    <span className="w-24 text-[12.5px] text-muted">
                      {t(`fields.types.${f.type as FieldType}`)}
                      {f.options?.length ? ` · ${f.options.length}` : ''}
                    </span>
                    {canWrite && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t('fields.remove', { label: f.label })}
                        onClick={() => void act(() => deleteField(f.id))}
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
              <form onSubmit={submit} className="flex flex-col gap-2.5 border-t border-line pt-4">
                <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
                  <div>
                    <label htmlFor="field-label" className={fieldLabel}>
                      {t('fields.label')}
                    </label>
                    <Input id="field-label" value={label} maxLength={60} placeholder={t('fields.labelPlaceholder')} onChange={(e) => setLabel(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="field-type" className={fieldLabel}>
                      {t('fields.type')}
                    </label>
                    <select id="field-type" className={selectClass} value={type} onChange={(e) => setType(e.target.value as FieldType)}>
                      {FIELD_TYPES.map((ft) => (
                        <option key={ft} value={ft}>
                          {t(`fields.types.${ft}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {type === 'select' && (
                  <div>
                    <label htmlFor="field-options" className={fieldLabel}>
                      {t('fields.options')}
                    </label>
                    <Input id="field-options" value={options} placeholder={t('fields.optionsPlaceholder')} onChange={(e) => setOptions(e.target.value)} />
                  </div>
                )}
                <Button type="submit" variant="primary" disabled={busy || !label.trim()} className="self-start">
                  {t('fields.add')}
                </Button>
              </form>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
