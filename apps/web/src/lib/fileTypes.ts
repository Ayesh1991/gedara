// What a document file is and how big (no network code here, so it can be unit-tested).
import { sniffImage, type ImageMime } from './images';

/** The bucket's own limit (migration 5); PDFs above it are refused before uploading. */
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export class FileError extends Error {
  constructor(public reason: 'unsupported' | 'tooLarge') {
    super(reason);
  }
}

/** A PDF starts with "%PDF-" (possibly after a few junk bytes, which readers tolerate up to 1 KB). */
export function sniffDocument(head: Uint8Array): 'application/pdf' | ImageMime | null {
  const text = String.fromCharCode(...head.subarray(0, Math.min(head.length, 1024)));
  if (text.includes('%PDF-')) return 'application/pdf';
  return sniffImage(head);
}

/** "2.4 MB" / "180 KB". */
export function formatBytes(n: number | null | undefined, locale = 'en-LK'): string {
  if (!n) return '';
  const f = (v: number, d: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: d }).format(v);
  if (n >= 1024 * 1024 * 1024) return `${f(n / 1024 ** 3, 2)} GB`;
  if (n >= 1024 * 1024) return `${f(n / 1024 ** 2, 1)} MB`;
  return `${f(Math.max(1, Math.round(n / 1024)), 0)} KB`;
}
