// Photo by scan (v0.13.0): the pure helpers (no Supabase import, so unit tests can load them).
import { z } from 'zod';

/**
 * `?photo=1` on /s/$code, /things/$assetId and /pantry/$productId. Kept as the number 1: the router
 * writes a string '1' as `?photo=%221%22`.
 */
export const photoSearchSchema = z.object({
  photo: z.union([z.string(), z.number()]).transform(Number).pipe(z.literal(1)).optional().catch(undefined),
});

export interface PhotoQrAccess {
  canWrite: boolean;
  isOwner: boolean;
  valuable: boolean;
}

/** Who may add a photo (the database enforces the same: migration 98 attachment policies). */
export function mayAddPhoto({ canWrite, isOwner, valuable }: PhotoQrAccess): boolean {
  return canWrite && (!valuable || isOwner);
}

/** Why the phone can't add the photo, or null when it can. */
export function photoRefusal(a: PhotoQrAccess): 'viewer' | 'valuable' | null {
  if (!a.canWrite) return 'viewer';
  if (a.valuable && !a.isOwner) return 'valuable';
  return null;
}

/** Android Chrome's ImageCapture gives a full-resolution still; everyone else grabs a video frame. */
export function stillSource(win: { ImageCapture?: unknown } | undefined): 'imageCapture' | 'frame' {
  return typeof win?.ImageCapture === 'function' ? 'imageCapture' : 'frame';
}
