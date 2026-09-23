import { Camera, Flashlight, FlashlightOff, ScanLine } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  cameraError,
  getDecoder,
  openRearCamera,
  setTorch,
  torchCapable,
  type CameraError,
} from '@/lib/scanner';
import { cn } from '@/lib/utils';

const FRAME_MS = 140;
const REPEAT_MS = 2000;

/**
 * Viewfinder. The camera starts only after a tap (iOS requires a user gesture) and stops when the
 * component unmounts or the app goes to the background. Repeat reads of the same code within 2 s
 * are ignored, so it can stay open for rapid-fire scanning.
 */
export function CameraScanner({
  onDetect,
  className,
  compact = false,
  autoStart = false,
  onRunningChange,
}: {
  onDetect: (text: string) => void;
  onRunningChange?: (running: boolean) => void;
  className?: string;
  compact?: boolean;
  autoStart?: boolean;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onDetectRef = useRef(onDetect);
  const lastRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [state, setState] = useState<'idle' | 'starting' | 'running' | CameraError>('idle');
  const [torch, setTorchState] = useState<boolean | null>(null);
  const [hit, setHit] = useState(0);

  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    onRunningChange?.(state === 'running');
  }, [state, onRunningChange]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setTorchState(null);
    setState((s) => (s === 'running' || s === 'starting' ? 'idle' : s));
  }, []);

  const start = useCallback(async () => {
    setState('starting');
    try {
      const [stream, decoder] = await Promise.all([openRearCamera(), getDecoder()]);
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      setTorchState(torchCapable(stream) ? false : null);
      setState('running');

      let busy = false;
      const tick = async () => {
        if (streamRef.current !== stream) return;
        if (!busy && video.readyState >= 2) {
          busy = true;
          try {
            const text = await decoder.decode(video);
            const now = Date.now();
            if (text && (text !== lastRef.current.text || now - lastRef.current.at > REPEAT_MS)) {
              lastRef.current = { text, at: now };
              setHit((h) => h + 1);
              navigator.vibrate?.(35);
              onDetectRef.current(text);
            } else if (text) {
              lastRef.current.at = now;
            }
          } catch {
            // A bad frame is not an error; keep going.
          } finally {
            busy = false;
          }
        }
        setTimeout(() => void tick(), FRAME_MS);
      };
      void tick();
    } catch (e) {
      stop();
      setState(cameraError(e));
    }
  }, [stop]);

  useEffect(() => {
    // Deferred a tick: starting sets state, which an effect body shouldn't do synchronously.
    const auto = autoStart ? setTimeout(() => void start(), 0) : undefined;
    const onHide = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearTimeout(auto);
      document.removeEventListener('visibilitychange', onHide);
      stop();
    };
  }, [autoStart, start, stop]);

  const running = state === 'running';
  const error = state !== 'idle' && state !== 'starting' && state !== 'running' ? state : null;

  return (
    <div className={cn('relative isolate overflow-hidden rounded-[26px] border border-line-2 bg-[#03050b]', className)}>
      {hit > 0 && <span key={hit} className="scan-hit pointer-events-none absolute inset-0 z-10 rounded-[26px]" aria-hidden />}
      <video
        ref={videoRef}
        playsInline
        muted
        className={cn('absolute inset-0 h-full w-full object-cover', !running && 'opacity-0')}
        aria-hidden
      />

      {running ? (
        <>
          {/* Viewfinder corners + beam */}
          <div className="pointer-events-none absolute inset-[14%] rounded-3xl" aria-hidden>
            {['top-0 left-0 border-t-2 border-l-2 rounded-tl-3xl', 'top-0 right-0 border-t-2 border-r-2 rounded-tr-3xl', 'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-3xl', 'right-0 bottom-0 border-r-2 border-b-2 rounded-br-3xl'].map(
              (c) => (
                <span key={c} className={cn('absolute h-9 w-9 border-accent-b', c)} />
              ),
            )}
            <div className="scan-beam" />
          </div>
          {torch !== null && (
            <button
              type="button"
              onClick={() => {
                const next = !torch;
                setTorchState(next);
                if (streamRef.current) void setTorch(streamRef.current, next);
              }}
              aria-label={t(torch ? 'scan.torchOff' : 'scan.torchOn')}
              aria-pressed={torch}
              className="glass-strong absolute top-3 right-3 flex h-11 w-11 items-center justify-center rounded-2xl"
            >
              {torch ? <FlashlightOff className="h-5 w-5" aria-hidden /> : <Flashlight className="h-5 w-5" aria-hidden />}
            </button>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div
            aria-hidden
            className="absolute top-1/2 left-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-35 blur-3xl"
            style={{ background: 'var(--glow)' }}
          />
          <div className="brand-gradient relative flex h-16 w-16 items-center justify-center rounded-3xl text-[#05070F]">
            <ScanLine className="h-8 w-8" aria-hidden />
          </div>
          <p className={cn('relative max-w-xs text-[#c5cce3]', compact ? 'text-[14px]' : 'text-[15px]')}>
            {error ? t(`scan.cameraErrors.${error}`) : t('scan.aim')}
          </p>
          <Button
            variant={compact ? 'accent' : 'primary'}
            className="relative"
            disabled={state === 'starting'}
            onClick={() => void start()}
          >
            <Camera className="h-[18px] w-[18px]" aria-hidden />
            {state === 'starting' ? t('scan.starting') : error ? t('scan.retryCamera') : t('scan.startCamera')}
          </Button>
        </div>
      )}
    </div>
  );
}
