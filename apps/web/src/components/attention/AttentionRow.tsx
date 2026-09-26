import { useQueryClient } from '@tanstack/react-query';
import {
  BellOff,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  Clock,
  HardDriveDownload,
  MessageSquareText,
  PiggyBank,
  Receipt,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  TrendingDown,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { TargetLink } from '@/components/insights/Num';
import { SEVERITY_TONE, attentionTarget, hiddenUntil, type AttentionItem, type AttentionKind, type HideChoice } from '@/lib/attention';
import { attentionKey, hideAttention, unhideAttention } from '@/lib/insights/queries';
import { formatLKR } from '@/lib/money/format';
import { formatQty } from '@/lib/pantry/units';
import { cn } from '@/lib/utils';

const ICON: Record<AttentionKind, LucideIcon> = {
  expired: CircleAlert,
  best_before_passed: Clock,
  due_soon: Clock,
  below_min: ShoppingCart,
  runs_out: TrendingDown,
  bill_due: Receipt,
  insurance_due: ShieldCheck,
  warranty_ending: ShieldAlert,
  service_due: Wrench,
  things_pending: Receipt,
  sms_review: MessageSquareText,
  scan_waiting: CloudDownload,
  backup_due: HardDriveDownload,
  budget_over: PiggyBank,
  budget_near: PiggyBank,
};

const TONE_BG = {
  red: 'bg-red/[0.08] hover:bg-red/[0.12]',
  caution: 'bg-caution/[0.08] hover:bg-caution/[0.12]',
  due: 'bg-due/[0.08] hover:bg-due/[0.12]',
  info: 'bg-info/[0.08] hover:bg-info/[0.12]',
  teal: 'bg-teal/[0.07] hover:bg-teal/[0.1]',
} as const;
const TONE_TEXT = { red: 'text-red', caution: 'text-caution', due: 'text-due', info: 'text-info', teal: 'text-teal' } as const;

/** "today", "tomorrow", "in 3 days", "2 days ago". */
export function useWhen() {
  const { t } = useTranslation();
  return (days: number | null) => {
    if (days === null) return '';
    if (days === 0) return t('attention.when.today');
    if (days === 1) return t('attention.when.tomorrow');
    if (days === -1) return t('attention.when.yesterday');
    return days > 0 ? t('attention.when.in', { count: days }) : t('attention.when.ago', { count: -days });
  };
}

/** The sentence for an item ("Milk has expired", "CEB is due in 3 days"). */
export function useAttentionText() {
  const { t } = useTranslation();
  const when = useWhen();
  return (i: AttentionItem): string => {
    const overdue = i.days_left !== null && i.days_left < 0;
    const title = i.title ?? '';
    switch (i.kind) {
      case 'things_pending':
        return t('attention.kinds.things_pending', { count: Number(i.qty ?? 0) });
      case 'sms_review':
        return t('attention.kinds.sms_review', { count: Number(i.qty ?? 0) });
      case 'scan_waiting':
        return t('attention.kinds.scan_waiting', { count: Number(i.qty ?? 0) });
      case 'backup_due':
        return t(i.extra.last_at ? 'attention.kinds.backup_due' : 'attention.kinds.backup_never');
      case 'bill_due':
      case 'insurance_due':
      case 'service_due':
        return t(`attention.kinds.${i.kind}${overdue ? '_overdue' : ''}` as 'attention.kinds.bill_due', { title, when: when(i.days_left) });
      default:
        return t(`attention.kinds.${i.kind}` as 'attention.kinds.expired', { title, when: when(i.days_left) });
    }
  };
}

/** Second line: amount, quantity or the thing's plan. */
function useAttentionDetail() {
  const { t } = useTranslation();
  return (i: AttentionItem): string | null => {
    switch (i.kind) {
      case 'bill_due':
      case 'insurance_due':
        return i.amount !== null ? t('attention.expected', { amount: formatLKR(Number(i.amount), { whole: true }) }) : null;
      case 'below_min':
      case 'runs_out':
      case 'expired':
      case 'best_before_passed':
      case 'due_soon':
        return i.qty !== null ? t('attention.left', { qty: formatQty(Number(i.qty), i.unit ? { code: i.unit } : undefined) }) : null;
      case 'service_due':
        return typeof i.extra.plan_name === 'string' ? i.extra.plan_name : null;
      case 'budget_over':
      case 'budget_near':
        return t('attention.budget', {
          spent: formatLKR(Number(i.amount ?? 0), { whole: true }),
          budget: formatLKR(Number(i.extra.budget ?? 0), { whole: true }),
        });
      case 'things_pending':
        return i.amount !== null ? formatLKR(Number(i.amount), { whole: true }) : null;
      default:
        return null;
    }
  };
}

/** One attention item: the row opens the record; the bell-off button hides it (with Undo). */
export function AttentionRow({
  item,
  householdId,
  canWrite,
  today,
}: {
  item: AttentionItem;
  householdId: string;
  canWrite: boolean;
  today: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const text = useAttentionText();
  const detail = useAttentionDetail();
  const [menu, setMenu] = useState(false);
  const tone = SEVERITY_TONE[item.severity];
  const Icon = ICON[item.kind];
  const sub = detail(item);

  async function hide(choice: HideChoice) {
    setMenu(false);
    try {
      await hideAttention(householdId, item.item_key, hiddenUntil(choice, today));
      await qc.invalidateQueries({ queryKey: attentionKey(householdId) });
      toast(t('attention.hidden'), {
        action: {
          label: t('common.undo'),
          onClick: () => {
            unhideAttention(householdId, item.item_key)
              .then(() => qc.invalidateQueries({ queryKey: attentionKey(householdId) }))
              .catch(() => toast.error(t('attention.error')));
          },
        },
      });
    } catch {
      toast.error(t('attention.error'));
    }
  }

  return (
    <li className="relative">
      <div className={cn('flex items-center gap-1 rounded-2xl pr-1', TONE_BG[tone])}>
        <TargetLink target={attentionTarget(item)} className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3">
          <Icon className={cn('h-5 w-5 shrink-0', TONE_TEXT[tone])} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px]">{text(item)}</span>
            {sub && <span className="tabular block truncate text-[12.5px] text-muted">{sub}</span>}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden />
        </TargetLink>
        {canWrite && (
          <button
            type="button"
            aria-label={t('attention.hide')}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-white/5 hover:text-text"
          >
            <BellOff className="h-[18px] w-[18px]" aria-hidden />
          </button>
        )}
      </div>
      {menu && (
        <div role="menu" className="glass-strong absolute right-1 z-10 mt-1 flex flex-col rounded-2xl p-1.5 text-[14px] shadow-xl">
          {(['tomorrow', 'week', 'change'] as const).map((c) => (
            <button key={c} type="button" role="menuitem" onClick={() => void hide(c)} className="rounded-xl px-3.5 py-2.5 text-left hover:bg-white/5">
              {t(`attention.hideFor.${c}`)}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
