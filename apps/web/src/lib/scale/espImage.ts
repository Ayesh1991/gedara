// Checks a firmware file before it is uploaded (Phase 6b, CLAUDE.md rule 6: don't trust the file
// name). An ESP32 app image starts with the image header (magic 0xE9, chip id at byte 12); the
// kitchen-scale firmware also carries a marker string `GEDARA-FW:<project>:<version>:END`
// (devices/kitchen-scale/src/version.h) that we read the version from. A full-flash image (bootloader
// + partition table + app) also starts with 0xE9, so a partition table at 0x8000 means "wrong file".

export const FIRMWARE_PROJECT = 'gedara-kitchen-scale';
const ESP_IMAGE_MAGIC = 0xe9;
const CHIP_ID_ESP32S3 = 9;
const MIN_SIZE = 64 * 1024;
const MAX_SIZE = 3 * 1024 * 1024; // one OTA slot (partitions_8mb.csv)

export type FirmwareProblem = 'too_small' | 'too_large' | 'not_esp' | 'wrong_chip' | 'full_flash' | 'not_gedara' | 'wrong_project';

export interface FirmwareInfo {
  version: string;
  project: string;
  size: number;
  chipId: number;
}

export type FirmwareCheck = { ok: true; info: FirmwareInfo } | { ok: false; problem: FirmwareProblem };

const MARKER = 'GEDARA-FW:';

function findMarker(bytes: Uint8Array): string | null {
  const m = [...MARKER].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + m.length < bytes.length; i++) {
    for (let j = 0; j < m.length; j++) if (bytes[i + j] !== m[j]) continue outer;
    let end = i + m.length;
    while (end < bytes.length && end - i < 120 && bytes[end] !== 0) end++;
    return String.fromCharCode(...bytes.subarray(i, end));
  }
  return null;
}

export function checkFirmware(bytes: Uint8Array): FirmwareCheck {
  if (bytes.length < MIN_SIZE) return { ok: false, problem: 'too_small' };
  if (bytes.length > MAX_SIZE) return { ok: false, problem: 'too_large' };
  if (bytes[0] !== ESP_IMAGE_MAGIC) return { ok: false, problem: 'not_esp' };
  // Partition table magic 0xAA 0x50 at 0x8000 = a merged/full-flash file, not firmware.bin.
  if (bytes.length > 0x8001 && bytes[0x8000] === 0xaa && bytes[0x8001] === 0x50) return { ok: false, problem: 'full_flash' };
  const chipId = bytes[12]! | (bytes[13]! << 8);
  if (chipId !== CHIP_ID_ESP32S3) return { ok: false, problem: 'wrong_chip' };

  const tag = findMarker(bytes);
  const m = tag ? /^GEDARA-FW:([a-z0-9-]{1,40}):([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,20})?):END$/.exec(tag) : null;
  if (!m) return { ok: false, problem: 'not_gedara' };
  if (m[1] !== FIRMWARE_PROJECT) return { ok: false, problem: 'wrong_project' };
  return { ok: true, info: { version: m[2]!, project: m[1]!, size: bytes.length, chipId } };
}

/** Lower-case hex sha256 (WebCrypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** "0.2.0" > "0.1.10"? Plain semver order without pre-release subtleties (enough for our own tags). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map(Number);
  const pb = b.split(/[-+]/)[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
