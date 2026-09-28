// Camera decoding for the Scan HUD. Native BarcodeDetector where the browser has one (Android
// Chrome, macOS), backed by zxing-wasm; zxing alone elsewhere (iOS Safari, Windows). The WASM file
// is bundled with the app (Vite `?url`), never fetched from a CDN, so scanning keeps working offline
// and under our headers.

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

export interface Decoder {
  engine: 'native' | 'zxing' | 'hybrid';
  decode(video: HTMLVideoElement): Promise<string | null>;
}

const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128'];

async function nativeDecoder(): Promise<Decoder | null> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = await Ctor.getSupportedFormats();
    if (!supported.includes('qr_code')) return null;
    const detector = new Ctor({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) });
    return {
      engine: 'native',
      async decode(video) {
        const found = await detector.detect(video);
        return found[0]?.rawValue ?? null;
      },
    };
  } catch {
    return null;
  }
}

async function zxingDecoder(): Promise<Decoder> {
  const [{ readBarcodes, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
  });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    engine: 'zxing',
    async decode(video) {
      if (!ctx || !video.videoWidth) return null;
      // Decode a centred square crop at ≤ 720 px: faster, and it's where the user aims.
      const side = Math.min(video.videoWidth, video.videoHeight);
      const out = Math.min(720, side);
      canvas.width = out;
      canvas.height = out;
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, out, out);
      const results = await readBarcodes(ctx.getImageData(0, 0, out, out), {
        formats: ['QRCode', 'EAN13', 'EAN8', 'UPCA', 'Code128'],
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
      return results.find((r) => r.isValid)?.text ?? null;
    },
  };
}

/**
 * Native first (fast, easy on the battery); on every `every`-th frame it misses, zxing looks at the
 * same frame too, and whichever reads the code wins (Phase 7d: Android's own detector missed a
 * printed A4 URL label that zxing reads at once). zxing loads only when first needed.
 */
export function hybridDecoder(native: Decoder, loadZxing: () => Promise<Decoder>, every = 2): Decoder {
  let misses = 0;
  let zxing: Promise<Decoder | null> | null = null;
  return {
    engine: 'hybrid',
    async decode(video) {
      const hit = await native.decode(video).catch(() => null);
      if (hit) {
        misses = 0;
        return hit;
      }
      misses += 1;
      if (misses % every !== 0) return null;
      zxing ??= loadZxing().catch(() => null);
      const z = await zxing;
      return z ? z.decode(video) : null;
    },
  };
}

let cached: Promise<Decoder> | null = null;

export function getDecoder(): Promise<Decoder> {
  cached ??= nativeDecoder().then((d) => (d ? hybridDecoder(d, zxingDecoder) : zxingDecoder()));
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

export type CameraError = 'denied' | 'notFound' | 'insecure' | 'unavailable';

export function cameraError(e: unknown): CameraError {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'insecure';
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  return 'unavailable';
}

/**
 * Phones and tablets open the camera with the Scan screen (Phase 7c) once the camera was allowed
 * for this site; laptops (USB scanner) and a first visit still wait for a tap, which the browser's
 * permission prompt needs anyway.
 */
export async function shouldAutoStart(
  env: { coarse: boolean; permission: () => Promise<PermissionState | null> } = {
    coarse: typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
    permission: async () => {
      try {
        const s = await navigator.permissions?.query({ name: 'camera' as PermissionName });
        return s?.state ?? null;
      } catch {
        return null; // Firefox / older Safari: no 'camera' permission query
      }
    },
  },
): Promise<boolean> {
  if (!env.coarse) return false;
  return (await env.permission()) === 'granted';
}

export async function openRearCamera(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('insecure', 'SecurityError');
  }
  // More detail than 720p so a small label reads from further away; continuous autofocus where the
  // phone offers it (ignored elsewhere).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as { focusMode?: string[] } | undefined;
  if (caps?.focusMode?.includes('continuous')) {
    await track!.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
  }
  return stream;
}

/** Torch (flash) on Android Chrome; iOS doesn't expose it. */
export function torchCapable(stream: MediaStream): boolean {
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
  return Boolean(caps?.torch);
}

export async function setTorch(stream: MediaStream, on: boolean) {
  const track = stream.getVideoTracks()[0];
  await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}
