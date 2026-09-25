import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Target } from '@/lib/attention';
import { formatLKR } from '@/lib/money/format';
import { cn } from '@/lib/utils';

/** A router target as <Link> props (the targets are built from typed route paths). */
export function TargetLink({ target, className, children, ...rest }: { target: Target; className?: string; children: ReactNode; title?: string; 'aria-label'?: string }) {
  return (
    <Link {...(target as unknown as LinkProps)} className={className} {...rest}>
      {children}
    </Link>
  );
}

/**
 * Every number is a link (MASTER_PLAN §4 row 10). `to` is required on purpose: Insights and Home
 * show amounts only through this, so an amount that leads nowhere doesn't type-check.
 */
export function Num({
  value,
  to,
  whole = false,
  signed = false,
  format,
  className,
  title,
}: {
  value: number;
  to: Target;
  whole?: boolean;
  /** Show − for negatives (money out) and + for positives. */
  signed?: boolean;
  /** Something other than rupees: '42 %', '3.2 kg'. */
  format?: (v: number) => string;
  className?: string;
  title?: string;
}) {
  const text = format ? format(value) : formatLKR(Math.abs(value), { whole });
  const sign = format ? '' : value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return (
    <TargetLink
      target={to}
      title={title}
      className={cn(
        'tabular whitespace-nowrap underline decoration-white/15 decoration-dotted underline-offset-4 hover:decoration-[var(--accent-b)] focus-visible:rounded focus-visible:outline-2 focus-visible:outline-[var(--accent-b)]',
        className,
      )}
    >
      {sign}
      {text}
    </TargetLink>
  );
}
