import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Camera, Images, Loader2, Pencil, Trash } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { ImageError } from '@/lib/images';
import { removeEntityPhoto, setEntityPhoto, type EntityPhoto, type PhotoEntity } from '@/lib/photos';
import { cn } from '@/lib/utils';

// Photos from the camera or the gallery, wherever a photo is shown (Phase 7b). Every file still goes
// through lib/photos (rule 9: WebP 1600 px + 320 px thumb, type sniffed from its bytes).

/** Phones and tablets: the OS camera (`capture`) takes better photos than a video frame. */
function nativeCamera(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/** Laptop / desktop: snap a frame from the webcam in a sheet. */
function CameraSnapSheet({ open, onClose, onPhoto }: { open: boolean; onClose: () => void; onPhoto: (f: File) => void }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'ready' | 'error'>('starting');

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (stopped || !videoRef.current) return stream.getTracks().forEach((tr) => tr.stop());
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setState('ready');
      } catch {
        if (!stopped) setState('error');
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((tr) => tr.stop());
      setState('starting');
    };
  }, [open]);

  function snap() {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onClose();
        onPhoto(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92,
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('photo.takeTitle')}>
      <div className="flex flex-col gap-3">
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-[#03050b]">
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-hidden />
          {state !== 'ready' && (
            <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-[14px] text-muted">
              {state === 'error' ? t('photo.noCamera') : t('scan.starting')}
            </p>
          )}
        </div>
        <Button variant="primary" disabled={state !== 'ready'} onClick={snap} className="w-full">
          <Camera className="h-[18px] w-[18px]" aria-hidden />
          {t('photo.snap')}
        </Button>
      </div>
    </Sheet>
  );
}

/** Two hidden inputs + the webcam sheet; `take()` / `choose()` open them. */
function usePhotoSources(onPhoto: (f: File) => void) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [snapOpen, setSnapOpen] = useState(false);
  const pick = (input: HTMLInputElement) => {
    const f = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (f) onPhoto(f);
  };
  const inputs = (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="photo-camera-input"
        onChange={(e) => pick(e.currentTarget)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="photo-gallery-input"
        onChange={(e) => pick(e.currentTarget)}
      />
      <CameraSnapSheet open={snapOpen} onClose={() => setSnapOpen(false)} onPhoto={onPhoto} />
    </>
  );
  return {
    inputs,
    take: () => (nativeCamera() ? cameraRef.current?.click() : setSnapOpen(true)),
    choose: () => galleryRef.current?.click(),
  };
}

/**
 * Forms: the photo tile plus "Take a photo" / "Choose from gallery" (and remove). The file is kept
 * by the form and uploaded when it saves.
 */
export function PhotoPicker({
  previewUrl,
  onPick,
  onRemove,
  canRemove,
  hint,
  className,
}: {
  previewUrl: string | null;
  onPick: (f: File) => void;
  onRemove: () => void;
  canRemove: boolean;
  hint?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const src = usePhotoSources(onPick);
  return (
    <div className={cn('flex items-center gap-3', className)} data-testid="photo-picker">
      <div className="glass flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl">
        {previewUrl ? <img src={previewUrl} alt="" className="h-full w-full object-cover" /> : <Images className="h-6 w-6 text-muted" aria-hidden />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={src.take}>
            <Camera className="h-4 w-4" aria-hidden />
            {t('photo.take')}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={src.choose}>
            <Images className="h-4 w-4" aria-hidden />
            {t('photo.gallery')}
          </Button>
          {canRemove && (
            <Button type="button" size="sm" variant="ghost" aria-label={t('places.removePhoto')} onClick={onRemove}>
              <Trash className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
        {hint && <p className="text-[12.5px] leading-snug text-muted">{hint}</p>}
      </div>
      {src.inputs}
    </div>
  );
}

/**
 * The pencil on a page's big photo: take / choose / remove, saved at once (no form).
 * `queryKey`: the photos query to refresh afterwards.
 */
export function PhotoEditButton({
  householdId,
  entityType,
  entityId,
  photo,
  queryKey,
  disabled,
  className,
}: {
  householdId: string;
  entityType: PhotoEntity;
  entityId: string;
  photo: EntityPhoto | null | undefined;
  queryKey: QueryKey;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useCallback(
    async (file: File) => {
      if (!navigator.onLine) return toast.error(t('photo.needsInternet'));
      setBusy(true);
      try {
        await setEntityPhoto(householdId, entityType, entityId, file, photo);
        await qc.invalidateQueries({ queryKey });
        toast.success(t(photo ? 'photo.replaced' : 'photo.added'));
      } catch (e) {
        toast.error(e instanceof ImageError ? t(`places.photoErrors.${e.reason}`) : t('places.photoErrors.upload'));
      } finally {
        setBusy(false);
      }
    },
    [householdId, entityType, entityId, photo, qc, queryKey, t],
  );
  // The inputs live inside the menu sheet: outside an open modal <dialog> they would be inert. The
  // sheet closes once a photo is picked (a cancelled picker leaves it open).
  const src = usePhotoSources((f) => {
    setMenu(false);
    void save(f);
  });

  async function remove() {
    if (!photo) return;
    setMenu(false);
    setBusy(true);
    try {
      await removeEntityPhoto(photo);
      await qc.invalidateQueries({ queryKey });
      toast.success(t('photo.removed'));
    } catch {
      toast.error(t('photo.removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => setMenu(true)}
        aria-label={t(photo ? 'photo.edit' : 'photo.add')}
        data-testid="photo-edit"
        className={cn(
          'glass-strong absolute top-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-2xl text-text disabled:opacity-60',
          className,
        )}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Pencil className="h-5 w-5" aria-hidden />}
      </button>
      <Sheet open={menu} onClose={() => setMenu(false)} title={t(photo ? 'photo.edit' : 'photo.add')}>
        <div className="flex flex-col gap-2">
          <Button variant="secondary" className="h-12 justify-start" onClick={src.take}>
            <Camera className="h-5 w-5" aria-hidden />
            {t('photo.take')}
          </Button>
          <Button variant="secondary" className="h-12 justify-start" onClick={src.choose}>
            <Images className="h-5 w-5" aria-hidden />
            {t('photo.gallery')}
          </Button>
          {photo && (
            <Button variant="ghost" className="h-12 justify-start text-red" onClick={() => void remove()}>
              <Trash className="h-5 w-5" aria-hidden />
              {t('places.removePhoto')}
            </Button>
          )}
          {src.inputs}
        </div>
      </Sheet>
    </>
  );
}
