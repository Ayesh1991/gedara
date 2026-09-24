import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** Aurora empty state: glow, gradient icon tile, title, body and optional actions (no fake numbers). */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <Card className="relative flex flex-col items-center gap-4 overflow-hidden px-6 py-10 text-center">
      <div
        aria-hidden
        className="absolute -top-20 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: 'var(--glow)' }}
      />
      <div className="brand-gradient relative flex h-16 w-16 items-center justify-center rounded-3xl text-[#05070F]">
        <Icon className="h-8 w-8" aria-hidden />
      </div>
      <div className="relative max-w-md">
        <h2 className="font-display text-[20px] font-semibold">{title}</h2>
        <p className="mt-1.5 text-[14.5px] leading-relaxed text-[#a5b0d0]">{body}</p>
      </div>
      {action && <div className="relative">{action}</div>}
    </Card>
  );
}
