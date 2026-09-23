// Camera decoding for the Scan HUD. Native BarcodeDetector where the browser has one (Android
// Chrome, macOS), otherwise zxing-wasm (iOS Safari, Windows). The WASM file is bundled with the app
// (Vite `?url`), never fetched from a CDN, so scanning keeps working offline and under our headers.

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

export interface Decoder {
  engine: 'native' | 'zxing';
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

let cached: Promise<Decoder> | null = null;

export function getDecoder(): Promise<Decoder> {
  cached ??= nativeDecoder().then((d) => d ?? zxingDecoder());
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

export async function openRearCamera(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('insecure', 'SecurityError');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
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
