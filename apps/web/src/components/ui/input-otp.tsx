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
        'relative flex h-14 w-11 items-center justify-center rounded-[10px] border border-line-2 bg-ink-2 tabular text-2xl',
        slot?.isActive && 'border-gold',
        className,
      )}
    >
      {slot?.char}
      {slot?.hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-px animate-pulse bg-text" />
        </div>
      )}
    </div>
  );
}
