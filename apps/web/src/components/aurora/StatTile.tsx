import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * KPI tile: label, big mono value, a footer row.
 * `side` sits beside the value (hidden on phones); `trend` sits at the right of the footer row.
 */
export function StatTile({
  label,
  value,
  footer,
  side,
  trend,
  highlight = false,
  empty = false,
}: {
  label: string;
  value: ReactNode;
  footer?: ReactNode;
  side?: ReactNode;
  trend?: ReactNode;
  highlight?: boolean;
  /** No data yet: value is muted. */
  empty?: boolean;
}) {
  return (
    <div
      className="glass flex min-w-0 flex-col gap-2 overflow-hidden rounded-[var(--r)] p-4 sm:p-5"
      style={
        highlight
          ? {
              background:
                'linear-gradient(160deg, color-mix(in srgb, var(--accent-b) 16%, transparent), var(--glass) 58%)',
              borderColor: 'color-mix(in srgb, var(--accent-b) 30%, transparent)',
            }
          : undefined
      }
    >
      <span className="truncate text-[12.5px] text-[#a5b0d0] sm:text-[13px]">{label}</span>
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            'tabular truncate text-[22px] leading-tight font-semibold tracking-tight sm:text-[28px]',
            empty && 'text-faint',
          )}
        >
          {value}
        </span>
        {side && <div className="hidden shrink-0 sm:block">{side}</div>}
      </div>
      {(footer || trend) && (
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted">
          <div className="min-w-0 truncate">{footer}</div>
          {trend && <div className="hidden shrink-0 sm:block">{trend}</div>}
        </div>
      )}
    </div>
  );
}
