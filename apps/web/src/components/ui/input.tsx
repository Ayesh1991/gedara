import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-12 w-full rounded-[10px] border border-line-2 bg-ink-2 px-3 text-[16px] text-text placeholder:text-muted focus:border-gold focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}
