// "SMS Backup & Restore" XML export → the bank alerts in it. Runs in the browser before anything is
// uploaded: only received SMS from allow-listed senders survive, OTP / promo texts are dropped here
// (and again on the server), so nothing else on the phone ever leaves the device.
// The export is flat (<smses><sms address=… date=… type=… body=… /></smses>), so a tolerant
// attribute scanner is enough — no DOMParser, which also keeps this testable in Node.
import { institutionFor, isPromo, isSecret } from '@sms/parse';

export const BACKUP_FILE_TYPES = ['text/xml', 'application/xml', ''];
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export interface BackupSms {
  sender: string;
  body: string;
  receivedAt: number; // epoch ms
}

export interface BackupScan {
  messages: BackupSms[];
  total: number; // <sms> elements in the file
  bySender: Record<string, number>; // kept, per institution
  dropped: { otherSenders: number; sent: number; secret: number; promo: number };
  first: number | null;
  last: number | null;
}

export type BackupError = 'type' | 'size' | 'notBackup';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decode(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** File type + size check before reading (rule 6: don't trust the extension). */
export function checkBackupFile(file: { type: string; size: number }): BackupError | null {
  if (!BACKUP_FILE_TYPES.includes(file.type)) return 'type';
  if (file.size > MAX_BACKUP_BYTES) return 'size';
  return null;
}

/** Optional date window (inclusive, epoch ms) keeps a whole-phone backup to the months you want. */
export function scanBackup(text: string, window?: { from?: number; to?: number }): BackupScan | { error: BackupError } {
  const head = text.slice(0, 2000);
  if (!/<smses[\s>]/i.test(head) && !/<smses[\s>]/i.test(text.slice(0, 200_000))) return { error: 'notBackup' };

  const scan: BackupScan = {
    messages: [], total: 0, bySender: {},
    dropped: { otherSenders: 0, sent: 0, secret: 0, promo: 0 }, first: null, last: null,
  };
  for (const m of text.matchAll(/<sms\s([^>]*?)\/?>/g)) {
    scan.total++;
    const a = attrs(m[1]!);
    const sender = (a.address ?? '').trim();
    const institution = institutionFor(sender);
    if (!institution) {
      scan.dropped.otherSenders++;
      continue;
    }
    if (a.type !== undefined && a.type !== '1') {
      scan.dropped.sent++; // 1 = received; 2 = sent, 3 = draft …
      continue;
    }
    const body = a.body ?? '';
    const at = Number(a.date);
    if (!body || !Number.isFinite(at) || at <= 0) continue;
    if (window?.from !== undefined && at < window.from) continue;
    if (window?.to !== undefined && at > window.to) continue;
    if (isSecret(body)) {
      scan.dropped.secret++;
      continue;
    }
    if (isPromo(body)) {
      scan.dropped.promo++;
      continue;
    }
    scan.messages.push({ sender, body, receivedAt: at });
    scan.bySender[institution] = (scan.bySender[institution] ?? 0) + 1;
    scan.first = scan.first === null ? at : Math.min(scan.first, at);
    scan.last = scan.last === null ? at : Math.max(scan.last, at);
  }
  scan.messages.sort((x, y) => x.receivedAt - y.receivedAt);
  return scan;
}
