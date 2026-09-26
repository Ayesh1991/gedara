import { Link } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  Minus,
  MoreHorizontal,
  PackageOpen,
  Plus,
  Trash2,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '@/components/ui/sheet';
import type { Product } from '@/lib/pantry/queries';
import type { StockStatus } from '@/lib/pantry/status';
import type { Unit } from '@/lib/pantry/units';
import type { EntityPhoto } from '@/lib/photos';
import { cn } from '@/lib/utils';
import { DueText, ProductArt, Qty, StatusChip, UnitPrice } from './bits';
import type { StockMode } from './StockSheet';
import { useSwipe } from './useSwipe';

export function ProductCard({
  product,
  unit,
  statuses,
  photo,
  today,
  locale,
  canWrite,
  onQuickUse,
  onMore,
  onUseAll,
  swipe = false,
  motion = true,
}: {
  product: Product;
  unit: Unit | undefined;
  statuses: StockStatus[];
  photo?: EntityPhoto | null;
  today: string;
  locale: string;
  canWrite: boolean;
  onQuickUse: () => void;
  onMore: () => void;
  /** Swipe left (opt-in): use everything. */
  onUseAll?: () => void;
  /** Swipe right = use the quick amount, left = use all, long-press = the ⋯ menu (Settings › Appearance). */
  swipe?: boolean;
  motion?: boolean;
}) {
  const { t } = useTranslation();
  const inStock = product.stock.qty > 0;
  const gesture = useSwipe({
    enabled: swipe && canWrite,
    allow: { right: inStock, left: inStock && Boolean(onUseAll) },
    onRight: onQuickUse,
    onLeft: () => onUseAll?.(),
    onLongPress: onMore,
  });
  const card = (
    <div
      className={cn(
        'glass flex items-center gap-3 rounded-[var(--r)] p-3',
        product.archived && 'opacity-60',
        swipe && canWrite && 'touch-pan-y select-none',
        motion && !gesture.dragging && 'transition-transform duration-200',
      )}
      style={gesture.offset ? { transform: `translateX(${gesture.offset}px)` } : undefined}
      data-testid="product-card"
      {...gesture.handlers}
    >
      <Link
        to="/pantry/$productId"
        params={{ productId: product.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
        aria-label={product.name}
      >
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl">
          <ProductArt product={product} photo={photo} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-display text-[16px] font-semibold">{product.name}</span>
            {product.name_si && <span className="truncate text-[12.5px] text-muted">{product.name_si}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px]">
            <Qty qty={product.stock.qty} unit={unit} className={inStock ? 'text-text' : 'text-muted'} />
            {inStock && <DueText dueType={product.due_type} due={product.stock.nextDue} today={today} locale={locale} className="text-[12.5px]" />}
            {inStock && <UnitPrice unitCost={product.stock.lastUnitCost} unit={unit} className="text-[12px] text-faint" />}
          </div>
          {statuses.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {statuses.map((s) => (
                <StatusChip key={s} status={s} />
              ))}
            </div>
          )}
        </div>
      </Link>
      {canWrite && (
        <div className="flex shrink-0 flex-col gap-1.5">
          {inStock && (
            <button
              type="button"
              onClick={onQuickUse}
              aria-label={t('pantry.useQuick', { qty: `${product.quick_consume_qty} ${unit?.code ?? ''}`.trim(), name: product.name })}
              className="glass tabular flex h-10 min-w-[3.25rem] items-center justify-center gap-0.5 rounded-xl px-2 text-[13px]"
            >
              <Minus className="h-3.5 w-3.5" aria-hidden />
              {product.quick_consume_qty}
            </button>
          )}
          <button
            type="button"
            onClick={onMore}
            aria-label={t('pantry.more', { name: product.name })}
            className="flex h-10 min-w-[3.25rem] items-center justify-center rounded-xl text-muted hover:bg-white/5"
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
  if (!swipe || !canWrite) return card;
  // What the swipe will do shows underneath as the card moves.
  return (
    <div className="relative overflow-hidden rounded-[var(--r)]">
      <div aria-hidden className="absolute inset-0 flex items-center justify-between px-5 text-[13px] font-semibold">
        <span className={cn('flex items-center gap-1.5 text-teal transition-opacity', gesture.offset > 0 ? 'opacity-100' : 'opacity-0')}>
          <Minus className="h-4 w-4" />
          {t('pantry.swipe.useQuick', { qty: `${product.quick_consume_qty} ${unit?.code ?? ''}`.trim() })}
        </span>
        <span className={cn('flex items-center gap-1.5 text-caution transition-opacity', gesture.offset < 0 ? 'opacity-100' : 'opacity-0')}>
          {t('pantry.swipe.useAll')}
          <Trash2 className="h-4 w-4" />
        </span>
      </div>
      {card}
    </div>
  );
}

const ACTIONS: Array<{ mode: StockMode; icon: LucideIcon; needsStock: boolean }> = [
  { mode: 'add', icon: Plus, needsStock: false },
  { mode: 'use', icon: UtensilsCrossed, needsStock: true },
  { mode: 'open', icon: PackageOpen, needsStock: true },
  { mode: 'move', icon: ArrowRightLeft, needsStock: true },
  { mode: 'count', icon: ClipboardCheck, needsStock: false },
  { mode: 'waste', icon: Trash2, needsStock: true },
];

/** The ⋯ menu: every stock action for one product (also opened by a long-press when swipe is on). */
export function ProductActionsSheet({
  product,
  open,
  onClose,
  onPick,
}: {
  product: Product | null;
  open: boolean;
  onClose: () => void;
  onPick: (mode: StockMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={product?.name ?? ''}>
      {product && (
        <div className="grid grid-cols-3 gap-2">
          {ACTIONS.filter((a) => !a.needsStock || product.stock.qty > 0).map(({ mode, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onPick(mode)}
              className={cn(
                'glass flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl text-[13px]',
                mode === 'waste' && 'text-red',
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {t(`pantry.actions.${mode}`)}
            </button>
          ))}
          {product.stock.nextDue && (
            <Link
              to="/pantry/$productId"
              params={{ productId: product.id }}
              onClick={onClose}
              className="glass flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl text-[13px]"
            >
              <CalendarClock className="h-5 w-5" aria-hidden />
              {t('pantry.actions.due')}
            </Link>
          )}
          <Link
            to="/pantry/$productId"
            params={{ productId: product.id }}
            onClick={onClose}
            className="glass flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl text-[13px]"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
            {t('pantry.actions.details')}
          </Link>
        </div>
      )}
    </Sheet>
  );
}
