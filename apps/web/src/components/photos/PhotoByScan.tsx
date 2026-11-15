// Photo by scan (v0.13.0). On the PC / iPad, a small QR sits in the photo space of a thing or a
// product: `<this site>/s/<its code>?photo=1`. Scanned in Gedara on a phone, the item's page opens
// with its camera already running (Gedara's own viewfinder: a web page may not open the phone's
// Camera app without a tap). One tap on the shutter saves the photo through lib/photos (rule 9),
// and the page on the PC shows it at once (Realtime on `attachment`, no polling: log budget).
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Camera, Check, Images, Loader2, RotateCcw, ScanLine, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePhotoSources } from '@/components/photos/PhotoControls';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { photoScanUrl } from '@/lib/codes';
import { ImageError } from '@/lib/images';
import { photoRefusal, stillSource, type PhotoQrAccess } from '@/lib/photoScan';
import { setEntityPhoto, type EntityPhoto } from '@/lib/photos';
import { qrSvgPath, urlQr } from '@/lib/qr';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type ItemType = 'asset' | 'product';

interface ImageCaptureLike {
  takePhoto: () => Promise<Blob>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

/** The QR as an SVG (2-module quiet zone; the white tile adds the rest). */
function UrlQr({ url, className }: { url: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const m = urlQr(url);
    return { path: qrSvgPath(m), size: m.size };
  }, [url]);
  return (
    <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} shapeRendering="crispEdges" role="img" aria-label={url} className={cn('bg-white', className)}>
      <path d={path} fill="#05070F" />
    </svg>
  );
}

/** While the QR is on screen (and the tab in front): refresh the photo when one is saved for this item. */
function useLivePhoto(entityType: ItemType, entityId: string, queryKey: QueryKey) {
  const qc = useQueryClient();
  const keyRef = useRef(queryKey);
  useEffect(() => {
    keyRef.current = queryKey;
  });
  useEffect(() => {
    const wide = window.matchMedia?.('(min-width: 768px)');
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let joinedBefore = false;
    const refresh = () => void qc.invalidateQueries({ queryKey: keyRef.current });
    const open = () => {
      if (channel || document.visibilityState !== 'visible' || wide?.matches === false) return;
      channel = supabase
        .channel(`photo-${entityType}-${entityId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attachment', filter: `entity_id=eq.${entityId}` }, (p) => {
          const row = p.new as { entity_type?: string; is_primary?: boolean };
          if (row.entity_type === entityType && row.is_primary) refresh();
        })
        .subscribe((status) => {
          // Re-joined (tab back in front, dropped connection): a photo may have come meanwhile.
          if (status === 'SUBSCRIBED') {
            if (joinedBefore) refresh();
            joinedBefore = true;
          }
        });
    };
    const close = () => {
      if (channel) void supabase.removeChannel(channel);
      channel = null;
    };
    const sync = () => (document.visibilityState === 'visible' && wide?.matches !== false ? open() : close());
    sync();
    document.addEventListener('visibilitychange', sync);
    wide?.addEventListener?.('change', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      wide?.removeEventListener?.('change', sync);
      close();
    };
  }, [qc, entityType, entityId]);
}

/**
 * The small QR in the upper-left corner of a photo space (PC and iPad; phones use the pencil).
 * Render it only when `mayAddPhoto` says so. A tap shows it bigger.
 */
export function PhotoQr({
  code,
  entityType,
  entityId,
  queryKey,
  className,
}: {
  code: string;
  entityType: ItemType;
  entityId: string;
  queryKey: QueryKey;
  className?: string;
}) {
  const { t } = useTranslation();
  const [big, setBig] = useState(false);
  const url = photoScanUrl(code, window.location.origin);
  useLivePhoto(entityType, entityId, queryKey);
  return (
    <>
      <button
        type="button"
        onClick={() => setBig(true)}
        title={t('photo.scan.hint')}
        aria-label={t('photo.scan.hint')}
        data-testid="photo-qr"
        data-url={url}
        className={cn(
          'absolute top-3 left-3 z-10 hidden flex-col items-center gap-1 rounded-2xl bg-white p-1.5 pb-1 text-[#05070F] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] md:flex',
          className,
        )}
      >
        <UrlQr url={url} className="h-[84px] w-[84px] lg:h-[96px] lg:w-[96px]" />
        <span className="flex items-center gap-1 text-[10.5px] font-semibold">
          <Camera className="h-3 w-3" aria-hidden />
          {t('photo.scan.label')}
        </span>
      </button>
      <Sheet open={big} onClose={() => setBig(false)} title={t('photo.scan.title')}>
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-3xl bg-white p-3">
            <UrlQr url={url} className="h-[260px] w-[260px]" />
          </div>
          <ol className="flex w-full flex-col gap-2 text-[14px] text-[#c5cce3]">
            <li className="flex items-center gap-2.5">
              <Smartphone className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
              {t('photo.scan.step1')}
            </li>
            <li className="flex items-center gap-2.5">
              <ScanLine className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
              {t('photo.scan.step2')}
            </li>
            <li className="flex items-center gap-2.5">
              <Camera className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
              {t('photo.scan.step3')}
            </li>
          </ol>
        </div>
      </Sheet>
    </>
  );
}


/**
 * The phone's rear camera with the shutter. Mounted only while the camera is shown, so a Retake
 * starts it fresh; "Start camera" (after an error) remounts it via `onRetry`.
 */
function CameraPane({ onShot, onRetry }: { onShot: (photo: Blob) => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'starting' | 'ready' | 'error'>('starting');

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (stopped || !videoRef.current) return stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (!stopped) setState('ready');
      } catch {
        if (!stopped) setState('error');
      }
    })();
    return () => {
      stopped = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
  }, []);

  /** A full-resolution still where the browser has ImageCapture (Android Chrome), else a video frame. */
  async function shoot() {
    const track = streamRef.current?.getVideoTracks()[0];
    const Ctor = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (track && Ctor && stillSource(window as unknown as { ImageCapture?: unknown }) === 'imageCapture') {
      try {
        return onShot(await new Ctor(track).takePhoto());
      } catch {
        // some cameras refuse takePhoto: fall back to the frame
      }
    }
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && onShot(b), 'image/jpeg', 0.92);
  }

  return (
    <>
      <div className="relative aspect-[3/4] max-h-[62dvh] w-full overflow-hidden rounded-2xl bg-[#03050b] sm:aspect-[4/3]">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-hidden data-testid="photo-scan-video" />
        {state !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-muted">
            {state === 'error' ? (
              <>
                <span>{t('photo.scan.noCamera')}</span>
                <Button variant="secondary" onClick={onRetry}>
                  <Camera className="h-4 w-4" aria-hidden />
                  {t('photo.scan.startCamera')}
                </Button>
              </>
            ) : (
              <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-label={t('scan.starting')} />
            )}
          </div>
        )}
      </div>
      <Button
        variant="primary"
        className="h-14 w-full text-[16px]"
        disabled={state !== 'ready'}
        onClick={() => void shoot()}
        data-testid="photo-scan-shutter"
      >
        <Camera className="h-5 w-5" aria-hidden />
        {t('photo.snap')}
      </Button>
    </>
  );
}

interface ScanSheetProps {
  householdId: string;
  entityType: ItemType;
  entityId: string;
  name: string;
  photo: EntityPhoto | null | undefined;
  queryKey: QueryKey;
  access: PhotoQrAccess;
}

/**
 * The item's page with `?photo=1` (from the QR): camera on at once, one tap saves the photo.
 * `onClose` takes `photo` out of the address bar.
 */
export function PhotoScanSheet({ open, onClose, ...props }: ScanSheetProps & { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t('photo.scan.sheetTitle', { name: props.name })} className="lg:max-w-xl">
      {/* The Sheet renders its content only while open: every opening starts clean. */}
      <PhotoScanBody {...props} onClose={onClose} />
    </Sheet>
  );
}

function PhotoScanBody({ householdId, entityType, entityId, photo, queryKey, access, onClose }: ScanSheetProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = photoRefusal(access);
  const [phase, setPhase] = useState<'camera' | 'saving' | 'saved'>('camera');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const save = useCallback(
    async (file: Blob) => {
      if (!navigator.onLine) return setError(t('photo.needsInternet'));
      setError(null);
      setPhase('saving');
      setPreview(URL.createObjectURL(file));
      try {
        await setEntityPhoto(householdId, entityType, entityId, file, photo);
        // Wait for the fresh photo: a Retake replaces this one, not the old one.
        await qc.invalidateQueries({ queryKey });
        setPhase('saved');
      } catch (e) {
        setPhase('camera');
        setError(e instanceof ImageError ? t(`places.photoErrors.${e.reason}`) : t('places.photoErrors.upload'));
      }
    },
    [householdId, entityType, entityId, photo, qc, queryKey, t],
  );
  const src = usePhotoSources((f) => void save(f));

  if (refusal) {
    return (
      <p className="rounded-2xl bg-white/5 px-4 py-5 text-[14.5px] leading-relaxed text-[#c5cce3]" data-testid="photo-scan-refused">
        {t(`photo.scan.refused.${refusal}`)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="photo-scan-sheet">
      {phase === 'camera' ? (
        <>
          {photo && <p className="text-[13px] text-muted">{t('photo.scan.replaces')}</p>}
          <CameraPane key={attempt} onShot={(b) => void save(b)} onRetry={() => setAttempt((n) => n + 1)} />
          {error && (
            <p role="alert" className="text-[13.5px] text-red">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="flex-1" onClick={src.take}>
              <Smartphone className="h-4 w-4" aria-hidden />
              {t('photo.scan.cameraApp')}
            </Button>
            <Button variant="ghost" size="sm" className="flex-1" onClick={src.choose}>
              <Images className="h-4 w-4" aria-hidden />
              {t('photo.gallery')}
            </Button>
          </div>
          {src.inputs}
        </>
      ) : (
        <>
          <div className="relative aspect-[3/4] max-h-[62dvh] w-full overflow-hidden rounded-2xl bg-[#03050b] sm:aspect-[4/3]">
            {preview && <img src={preview} alt="" className="h-full w-full object-cover" />}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-4 pt-10 pb-4 text-[15px] font-semibold">
              {phase === 'saving' ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />
                  {t('photo.scan.saving')}
                </>
              ) : (
                <span className="flex items-center gap-2 text-teal" data-testid="photo-scan-saved">
                  <Check className="h-5 w-5" aria-hidden />
                  {t('photo.scan.saved')}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="h-12 flex-1" disabled={phase === 'saving'} onClick={() => setPhase('camera')}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t('photo.scan.retake')}
            </Button>
            <Button variant="primary" className="h-12 flex-1" disabled={phase === 'saving'} onClick={onClose}>
              <Check className="h-4 w-4" aria-hidden />
              {t('photo.scan.done')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
