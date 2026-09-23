import { OTPInput, OTPInputContext } from 'input-otp';
import { useContext, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function InputOTP({ className, containerClassName, ...props }: ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      containerClassName={cn('flex items-center gap-2 has-disabled:opacity-50', containerClassName)}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

export function InputOTPSlot({ index, className }: { index: number; className?: string }) {
  const ctx = useContext(OTPInputContext);
  const slot = ctx.slots[index];
  return (
    <div
      className={cn(
        'tabular relative flex h-14 flex-1 items-center justify-center rounded-[14px] border border-line-2 bg-white/5 text-2xl font-semibold transition-[box-shadow,border-color]',
        slot?.isActive &&
          'border-accent-a bg-[color-mix(in_srgb,var(--accent-a)_12%,transparent)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent-a)_18%,transparent),0_0_24px_color-mix(in_srgb,var(--accent-a)_35%,transparent)]',
        className,
      )}
    >
      {slot?.char}
      {slot?.hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="caret-blink h-7 w-0.5 bg-text" />
        </div>
      )}
    </div>
  );
}
