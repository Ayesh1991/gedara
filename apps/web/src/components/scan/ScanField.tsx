import { Camera, Usb } from 'lucide-react';
import { useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { barcodeText } from '@/lib/codes';
import { cn } from '@/lib/utils';
import { CameraScanner } from './CameraScanner';
import { useScanCapture } from './WedgeListener';

/**
 * The phone camera in a sheet: the first read is handed over and the sheet closes. The USB scanner
 * works too while it is open (same result, same place). An `onScan` that returns (or resolves to)
 * `false` keeps the sheet open for another try (e.g. "that's not a place label").
 */
export function ScanSheet({
  open,
  onClose,
  onScan,
  title,
  hint,
  message,
}: {
  open: boolean;
  onClose: () => void;
  onScan: (text: string) => boolean | void | Promise<boolean | void>;
  title?: string;
  hint?: string;
  /** Why the last scan didn't fit (shown in the sheet: a toast would sit under the open dialog). */
  message?: string | null;
}) {
  const { t } = useTranslation();
  const busy = useRef(false);
  const take = (text: string) => {
    if (busy.current) return;
    const r = onScan(text);
    if (!(r instanceof Promise)) {
      if (r !== false) onClose();
      return;
    }
    busy.current = true;
    void r
      .then((ok) => ok !== false && onClose())
      .finally(() => {
        busy.current = false;
      });
  };
  useScanCapture(take, open);
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t('scan.sheet.title')}>
      {open && (
        <div className="flex flex-col gap-3" data-testid="scan-sheet">
          <CameraScanner onDetect={take} autoStart compact className="aspect-square w-full sm:aspect-[4/3]" />
          {message && (
            <p role="alert" className="rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-[13.5px] text-caution" data-testid="scan-sheet-message">
              {message}
            </p>
          )}
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Usb className="h-4 w-4 shrink-0" aria-hidden />
            {hint ?? t('scan.sheet.hint')}
          </p>
        </div>
      )}
    </Sheet>
  );
}

/** Camera icon button that opens the ScanSheet. */
export function ScanButton({
  onScan,
  label,
  title,
  className,
}: {
  onScan: (text: string) => void;
  label?: string;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label ?? t('scan.sheet.open')}
        className={cn(
          'glass flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] text-accent-b transition-colors hover:text-text',
          className,
        )}
      >
        <Camera className="h-5 w-5" aria-hidden />
      </button>
      <ScanSheet open={open} onClose={() => setOpen(false)} onScan={onScan} title={title} />
    </>
  );
}

/**
 * A barcode input with a camera button. The USB scanner types into it as before; its Enter fills
 * the field (`onScan`) instead of submitting the surrounding form.
 */
export function ScanField({
  value,
  onChange,
  onScan,
  normalise = barcodeText,
  cameraLabel,
  className,
  inputClassName,
  buttonClassName,
  ...input
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  /** After a camera read or Enter: e.g. add the barcode at once. */
  onScan?: (value: string) => void;
  normalise?: (raw: string) => string;
  cameraLabel?: string;
  inputClassName?: string;
  buttonClassName?: string;
}) {
  return (
    <div className={cn('flex min-w-0 gap-2', className)}>
      <Input
        {...input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = normalise(value);
          onChange(v);
          if (v) onScan?.(v);
        }}
        className={cn('tabular min-w-0 flex-1', input.readOnly && 'opacity-80', inputClassName)}
      />
      <ScanButton
        label={cameraLabel}
        className={buttonClassName}
        onScan={(raw) => {
          const v = normalise(raw);
          onChange(v);
          if (v) onScan?.(v);
        }}
      />
    </div>
  );
}
