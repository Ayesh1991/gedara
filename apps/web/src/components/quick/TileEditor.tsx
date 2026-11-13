// Edit tiles (Phase 12): each person's own tiles — add, rename, reorder, hide, usual amount,
// category — plus the Quick spend switches (tile order, hand, cash check). Plain writes on the
// person's own rows (RLS); loaded only when opened.
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CategorySelect, fieldLabel, selectClass } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { parseAmount } from '@/lib/money/format';
import { categoriesQuery } from '@/lib/money/queries';
import { HARD_STOP } from '@/lib/quick/rank';
import { addTile, deleteTile, saveOrder, updatePrefs, updateTile, type Prefs, type QuickState, type Tile } from '@/lib/quick/state';
import { useTileName } from './QuickScreen';
import type { Identity } from './useQuick';

interface Draft {
  id: string | null;
  label: string;
  icon: string;
  categoryId: string | null;
  usual: string;
  kind: Tile['kind'];
}

export default function TileEditor({
  identity, state, onClose, onChanged,
}: {
  identity: Identity;
  state: QuickState;
  onClose: () => void;
  onChanged: () => unknown;
}) {
  const { t } = useTranslation();
  const tileName = useTileName();
  const categories = useQuery(categoriesQuery(identity.householdId));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const tiles = [...state.tiles].sort((a, b) => a.sort - b.sort);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch {
      toast.error(t('quick.edit.failed'));
    } finally {
      setBusy(false);
    }
  }

  const move = (id: string, by: -1 | 1) => {
    const ids = tiles.map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => saveOrder(tiles, ids));
  };
  const setPref = (patch: Partial<Prefs>) => void run(() => updatePrefs(identity.householdId, identity.userId, patch));

  async function saveDraft() {
    if (!draft) return;
    const label = draft.label.trim();
    const usual = draft.usual.trim() ? parseAmount(draft.usual) : null;
    if (!label || (draft.usual.trim() && (usual === null || usual <= 0 || usual > HARD_STOP))) {
      toast.error(t('quick.edit.invalid'));
      return;
    }
    const input = { label, icon: draft.icon.trim() || null, category_id: draft.kind === 'handover' ? null : draft.categoryId, usual_amount: usual };
    await run(() => (draft.id ? updateTile(draft.id, input) : addTile(identity.householdId, input, Math.max(0, ...tiles.map((x) => x.sort)) + 1)));
    setDraft(null);
  }

  return (
    <Sheet open onClose={onClose} title={t('quick.edit.title')}>
      {draft ? (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <div className="flex gap-2.5">
            <label className="w-20">
              <span className={fieldLabel}>{t('quick.edit.icon')}</span>
              <Input value={draft.icon} maxLength={8} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} className="text-center text-[20px]" />
            </label>
            <label className="flex-1">
              <span className={fieldLabel}>{t('quick.edit.name')}</span>
              <Input value={draft.label} maxLength={24} required autoFocus onChange={(e) => setDraft({ ...draft, label: e.target.value })} data-testid="quick-edit-name" />
            </label>
          </div>
          {draft.kind === 'expense' && (
            <label>
              <span className={fieldLabel}>{t('quick.edit.category')}</span>
              <CategorySelect categories={categories.data ?? []} value={draft.categoryId} onChange={(id) => setDraft({ ...draft, categoryId: id })} kind="expense" />
            </label>
          )}
          <label>
            <span className={fieldLabel}>{t('quick.edit.usual')}</span>
            <Input inputMode="decimal" value={draft.usual} onChange={(e) => setDraft({ ...draft, usual: e.target.value })} className="tabular font-mono" data-testid="quick-edit-usual" />
            <span className="mt-1 block text-[12px] text-muted">{t('quick.edit.usualHint')}</span>
          </label>
          <div className="flex gap-2.5">
            <Button type="submit" className="flex-1" disabled={busy} data-testid="quick-edit-save">
              {t('common.save')}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            {draft.id && (
              <Button
                variant="destructive"
                size="icon"
                aria-label={t('quick.delete')}
                disabled={busy}
                onClick={() => {
                  const id = draft.id!;
                  setDraft(null);
                  void run(() => deleteTile(id));
                }}
              >
                <Trash className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-1.5" data-testid="quick-edit-list">
            {tiles.map((x, i) => (
              <li key={x.id} className={`flex items-center gap-1.5 rounded-xl bg-white/[0.03] px-2 py-1.5 ${x.hidden ? 'opacity-55' : ''}`}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-1.5 text-left"
                  onClick={() => setDraft({
                    id: x.id, label: tileName(x), icon: x.icon ?? '', categoryId: x.category_id,
                    usual: x.usual_amount ? String(x.usual_amount) : '', kind: x.kind,
                  })}
                >
                  <span className="w-6 text-center text-[18px]" aria-hidden>{x.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">{tileName(x)}</span>
                  {x.usual_amount !== null && <span className="tabular font-mono text-[12.5px] text-muted">{x.usual_amount.toLocaleString('en-LK')}</span>}
                </button>
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t('quick.edit.up')} disabled={busy || i === 0} onClick={() => move(x.id, -1)}>
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t('quick.edit.down')} disabled={busy || i === tiles.length - 1} onClick={() => move(x.id, 1)}>
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9"
                  aria-label={x.hidden ? t('quick.edit.show') : t('quick.edit.hide')}
                  aria-pressed={!x.hidden}
                  disabled={busy}
                  onClick={() => void run(() => updateTile(x.id, { hidden: !x.hidden }))}
                >
                  {x.hidden ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </Button>
              </li>
            ))}
          </ul>
          <Button data-testid="quick-edit-add" onClick={() => setDraft({ id: null, label: '', icon: '', categoryId: null, usual: '', kind: 'expense' })}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('quick.edit.add')}
          </Button>

          {state.prefs && (
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <label className="flex items-center gap-3 text-[14px]">
                <span className="flex-1">{t('quick.edit.order')}</span>
                <select className={`${selectClass} w-auto`} value={state.prefs.order_mode} disabled={busy} onChange={(e) => setPref({ order_mode: e.target.value as Prefs['order_mode'] })}>
                  <option value="learned">{t('quick.edit.orderLearned')}</option>
                  <option value="mine">{t('quick.edit.orderMine')}</option>
                </select>
              </label>
              <label className="flex items-center gap-3 text-[14px]">
                <span className="flex-1">{t('quick.edit.hand')}</span>
                <select className={`${selectClass} w-auto`} value={state.prefs.hand} disabled={busy} onChange={(e) => setPref({ hand: e.target.value as Prefs['hand'] })}>
                  <option value="right">{t('quick.edit.handRight')}</option>
                  <option value="left">{t('quick.edit.handLeft')}</option>
                </select>
              </label>
              <div className="flex items-center gap-3 text-[14px]">
                <span className="flex-1">{t('quick.edit.cashCheck')}</span>
                <Toggle on={state.prefs.cash_check} disabled={busy} label={t('quick.edit.cashCheck')} onChange={(v) => setPref({ cash_check: v })} />
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
