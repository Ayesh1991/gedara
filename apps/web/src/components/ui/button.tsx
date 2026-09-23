import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Gold (`primary`) is reserved for the single primary action on a screen (rule 11).
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[14px] font-display font-semibold transition-[filter,background-color,box-shadow] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'glow-gold hover:brightness-105',
        secondary: 'glass text-text hover:bg-white/5',
        accent:
          'text-text border border-[color-mix(in_srgb,var(--accent-a)_50%,transparent)] bg-[color-mix(in_srgb,var(--accent-a)_18%,transparent)] shadow-[0_0_24px_color-mix(in_srgb,var(--accent-a)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent-a)_26%,transparent)]',
        ghost: 'text-text hover:bg-white/5',
        destructive: 'bg-transparent text-red border border-red/40 hover:bg-red/10',
      },
      size: {
        md: 'h-12 px-5 text-[15px]',
        sm: 'h-9 px-3 text-sm',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
