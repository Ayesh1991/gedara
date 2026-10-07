// Web NFC (Android Chrome only) for the stickers under kitchen containers (Phase 6b). A container's tag
// gets ONE NDEF URL record, https://gedara.vercel.app/s/HL:LOC:XXXXXX, so an iPhone or any phone opens
// the jar's page with a tap, and the scale can link an unknown tag by that code; the tag's serial
// number (its UID) is what the scale reads first. Pure: the reader is injected, so tests use a fake.
import { normaliseUid } from '@scale/protocol';

// Just what we use of the Web NFC API (not in TypeScript's DOM lib yet).
export interface NdefRecordLike {
  recordType: string;
  data?: DataView;
  encoding?: string;
}
export interface NdefReadingEvent extends Event {
  serialNumber: string;
  message: { records: NdefRecordLike[] };
}
export interface NdefReaderLike extends EventTarget {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: { recordType: 'url'; data: string }[] }, options?: { signal?: AbortSignal; overwrite?: boolean }): Promise<void>;
}
type NdefReaderCtor = new () => NdefReaderLike;

function ctor(): NdefReaderCtor | null {
  const c = (globalThis as { NDEFReader?: NdefReaderCtor }).NDEFReader;
  return typeof c === 'function' ? c : null;
}

/** Android Chrome over HTTPS. iPhones and desktops don't have Web NFC. */
export function nfcSupported(): boolean {
  return ctor() !== null && (typeof window === 'undefined' || window.isSecureContext);
}

export interface TagRead {
  uid: string | null;
  /** The first URL record, if any. */
  url: string | null;
}

function urlOf(records: NdefRecordLike[]): string | null {
  for (const r of records) {
    if ((r.recordType === 'url' || r.recordType === 'absolute-url') && r.data) {
      return new TextDecoder(r.encoding ?? 'utf-8').decode(r.data);
    }
  }
  return null;
}

/** Next tag held to the phone: its UID and URL. Rejects with AbortError when `signal` aborts. */
export function readTag(signal: AbortSignal, make: () => NdefReaderLike = () => new (ctor()!)()): Promise<TagRead> {
  return new Promise<TagRead>((resolve, reject) => {
    const reader = make();
    const onReading = (e: Event) => {
      const ev = e as NdefReadingEvent;
      reader.removeEventListener('reading', onReading);
      resolve({ uid: normaliseUid(ev.serialNumber), url: urlOf(ev.message?.records ?? []) });
    };
    reader.addEventListener('reading', onReading);
    reader.addEventListener('readingerror', () => reject(new Error('read_failed')), { once: true });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    reader.scan({ signal }).catch(reject);
  });
}

/**
 * Write the container's URL to the next tag held to the phone and return that tag's UID. The scan
 * runs alongside the write because write() itself doesn't say which tag it wrote.
 */
export async function writeTag(url: string, signal: AbortSignal, make: () => NdefReaderLike = () => new (ctor()!)()): Promise<TagRead> {
  const reader = make();
  const seen = new Promise<string | null>((resolve) => {
    const onReading = (e: Event) => {
      reader.removeEventListener('reading', onReading);
      resolve(normaliseUid((e as NdefReadingEvent).serialNumber));
    };
    reader.addEventListener('reading', onReading);
  });
  await reader.scan({ signal });
  await reader.write({ records: [{ recordType: 'url', data: url }] }, { signal, overwrite: true });
  // The tag is still on the phone when the write succeeds; wait a moment for its serial number.
  const uid = await Promise.race([seen, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  return { uid, url };
}

/** The container's URL as written to its tag. */
export function containerTagUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/s/${code}`;
}
