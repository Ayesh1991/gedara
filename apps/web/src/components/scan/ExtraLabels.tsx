import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { assignedTagsQuery, detachTag, invalidateLabels, tagErrorKey } from '@/lib/labels/blank';
import { blankLabelText, tagTarget, type TagTarget } from '@/lib/labels/tags';

/**
 * Blank labels (HL:TAG) that were assigned to this item, next to its own code. Detach makes the
 * sticker blank again (it can then be scanned and given a new meaning).
 */
export function ExtraLabels({ householdId, target, canWrite }: { householdId: string; target: TagTarget; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tags = useQuery(assignedTagsQuery(householdId));
  const mine = (tags.data ?? []).filter((x) => {
    const tt = tagTarget(x);
    return tt?.kind === target.kind && tt.id === target.id;
  });
  if (!mine.length) return null;

  async function detach(code: string) {
    try {
      await detachTag(code, target.id);
      await invalidateLabels(qc, householdId);
      toast.success(t('blank.detached', { code }));
    } catch (e) {
      toast.error(t(`scan.claim.errors.${tagErrorKey(e)}`));
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-white/[0.02] px-3 py-2.5" data-testid="extra-labels">
      <div className="text-[12px] text-muted">{t('blank.extraLabels', { count: mine.length })}</div>
      <ul className="flex flex-col gap-1">
        {mine.map((x) => (
          <li key={x.id} className="flex items-center gap-2 text-[13.5px]">
            <Tag className="h-3.5 w-3.5 shrink-0 text-accent-b" aria-hidden />
            <span className="tabular min-w-0 flex-1 truncate">
              {x.code}
              {x.sheet && <span className="text-muted"> · {blankLabelText(x.sheet.sheet_no, x.slot)}</span>}
            </span>
            {canWrite && (
              <button type="button" onClick={() => void detach(x.code)} className="text-[12.5px] text-muted underline-offset-2 hover:text-text hover:underline">
                {t('blank.detach')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
