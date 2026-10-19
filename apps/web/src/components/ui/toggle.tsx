import { cn } from '@/lib/utils';

/** An on/off switch (role="switch"), teal when on. */
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40', on ? 'bg-teal' : 'bg-white/15')}
    >
      <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-[left] motion-reduce:transition-none', on ? 'left-6' : 'left-1')} />
    </button>
  );
}
