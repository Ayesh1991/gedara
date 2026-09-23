import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Native <dialog> as a bottom sheet (phones) / centred panel (lg). showModal() gives us focus
 * trapping, Esc to close and a top-layer backdrop without a dialog library.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
      className={cn(
        'sheet m-0 mt-auto border border-line-2 bg-[rgba(9,12,24,0.97)] shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.9)] max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-[28px] border-b-0 p-0 text-text',
        'lg:m-auto lg:max-w-lg lg:rounded-[28px] lg:border-b',
        className,
      )}
    >
      {open && (
        <div className="pb-safe flex flex-col gap-5 px-5 pt-3 pb-6 lg:px-7 lg:pt-6">
          <div className="mx-auto h-1.5 w-11 rounded-full bg-white/15 lg:hidden" aria-hidden />
          <div className="flex items-center gap-3">
            <h2 className="flex-1 font-display text-[20px] font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-line-2 bg-white/5"
            >
              <X className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
