import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatLKR } from '@/lib/money/format';
import { invalidatePantry, pantryErrorKey, undoStock, type JournalRow } from '@/lib/pantry/queries';
import { formatQty } from '@/lib/pantry/units';
import { cn } from '@/lib/utils';

interface Group {
  id: string;
  at: string;
  actor: string | null;
  rows: JournalRow[];
  undone: boolean;
  isUndo: boolean;
}

/** One entry per action (correlation), newest first; each can be undone once. */
export function JournalList({
  rows,
  householdId,
  canWrite,
  showProduct,
  locale,
}: {
  rows: JournalRow[];
  householdId: string;
  canWrite: boolean;
  showProduct: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const out: Group[] = [];
    const byId = new Map<string, Group>();
    for (const r of rows) {
      const id = r.correlation_id ?? r.id ?? '';
      let g = byId.get(id);
      if (!g) {
        g = { id, at: r.created_at ?? '', actor: r.actor_name, rows: [], undone: false, isUndo: false };
        byId.set(id, g);
        out.push(g);
      }
      g.rows.push(r);
      if (r.undone) g.undone = true;
      if (r.reason === 'undo') g.isUndo = true;
    }
    return out;
  }, [rows]);

  const time = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  async function undo(id: string) {
    setBusy(id);
    try {
      await undoStock(id);
      await invalidatePantry(qc, householdId);
      toast(t('pantry.done.undone'));
    } catch (e) {
      toast.error(t(`pantry.errors.${pantryErrorKey(e)}`));
    } finally {
      setBusy(null);
    }
  }

  if (groups.length === 0) return <p className="text-[14px] text-[#a5b0d0]">{t('pantry.journal.empty')}</p>;

  return (
    <ul className="flex flex-col gap-2" data-testid="journal">
      {groups.map((g) => (
        <li key={g.id} className={cn('glass rounded-2xl px-4 py-3', g.undone && 'opacity-55')}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="tabular text-[12px] text-muted">
                {g.at ? time.format(new Date(g.at)) : ''}
                {g.actor ? ` · ${g.actor}` : ''}
                {g.undone && <span className="ml-2 rounded-full bg-white/10 px-1.5 text-[10.5px] uppercase">{t('pantry.journal.undoneBadge')}</span>}
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {g.rows.map((r) => (
                  <li key={r.id} className={cn('flex flex-wrap items-baseline gap-x-2 text-[14px]', g.undone && 'line-through')}>
                    <span className="font-medium">{t(`pantry.journal.reasons.${(r.reason ?? 'edit') as Reason}`)}</span>
                    {showProduct && r.product_id && (
                      <Link to="/pantry/$productId" params={{ productId: r.product_id }} className="text-accent-b">
                        {r.product_name}
                      </Link>
                    )}
                    {r.delta !== null && r.delta !== 0 && (
                      <span className={cn('tabular', r.delta > 0 ? 'text-teal' : 'text-text')}>
                        {r.delta > 0 ? '+' : '−'}
                        {formatQty(Math.abs(r.delta), r.unit_code ? { code: r.unit_code } : undefined)}
                      </span>
                    )}
                    {r.reason === 'edit' && r.meta && (
                      <span className="tabular text-[12.5px] text-muted">{dueChange(r.meta)}</span>
                    )}
                    {r.location_path && <span className="truncate text-[12.5px] text-muted">{r.location_path}</span>}
                    {r.reason !== 'undo' && r.unit_cost !== null && r.delta !== null && r.delta < 0 && r.unit_cost > 0 && (
                      <span className="tabular text-[12px] text-faint">{formatLKR(Math.abs(r.delta) * r.unit_cost)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            {canWrite && !g.undone && !g.isUndo && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === g.id}
                onClick={() => void undo(g.id)}
                aria-label={t('pantry.journal.undoLabel')}
              >
                <Undo2 className="h-4 w-4" aria-hidden />
                {t('common.undo')}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

type Reason = 'purchase' | 'consume' | 'waste' | 'open' | 'transfer_out' | 'transfer_in' | 'adjust' | 'edit' | 'undo';

function dueChange(meta: unknown): string {
  const m = meta as { before?: { due_date?: string | null }; after?: { due_date?: string | null } } | null;
  if (!m?.before || !('due_date' in m.before)) return '';
  return `${m.before.due_date ?? '—'} → ${m.after?.due_date ?? '—'}`;
}
