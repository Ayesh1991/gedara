import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-12 w-full rounded-[14px] border border-line-2 bg-white/5 px-4 text-[16px] text-text placeholder:text-faint focus:border-accent-a focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent-a)_18%,transparent)] focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}
