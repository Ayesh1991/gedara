import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Gold (`primary`) is reserved for the single primary action on a screen (rule 11).
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[10px] font-display font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-gold text-primary-foreground hover:brightness-105 shadow-[0_0_24px_var(--gold-soft)]',
        secondary: 'bg-panel-2 text-text border border-line-2 hover:bg-panel',
        ghost: 'text-text hover:bg-panel-2',
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
