// Song details from the file itself (Phase 7h): title, artist, album, track number and the cover,
// read in the browser before upload so the library looks right the moment a song is added.
// Small readers for the tag formats people actually have:
//   MP3  ID3v2.3 / ID3v2.4 (TIT2 TPE1 TALB TRCK APIC)
//   FLAC VORBIS_COMMENT + PICTURE blocks
//   M4A  moov › udta › meta › ilst (©nam ©ART ©alb trkn covr), wherever moov sits in the file
//   OGG  Vorbis / Opus comments in the first pages (no cover)
// Anything else, or a file without tags, gets its title from the file name. Nothing here trusts
// the extension: the type comes from sniffAudio (first bytes).
import { sniffAudio, type MediaMime } from '@media/protocol';

export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  trackNo?: number;
  cover?: { mime: string; data: Uint8Array };
}

const MAX_TAG_BYTES = 8 * 1024 * 1024; // a tag (with its cover) bigger than this is skipped

async function bytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
  return t ? t.slice(0, 200) : undefined;
}

function trackNumber(s: string | undefined): number | undefined {
  const n = Number.parseInt((s ?? '').split('/')[0] ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 999 ? n : undefined;
}

// ── ID3v2 ─────────────────────────────────────────────────────────────────────
const syncsafe = (b: Uint8Array, o: number) => ((b[o]! & 0x7f) << 21) | ((b[o + 1]! & 0x7f) << 14) | ((b[o + 2]! & 0x7f) << 7) | (b[o + 3]! & 0x7f);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

function decodeText(enc: number, b: Uint8Array): string {
  if (enc === 0) return latin1(b);
  if (enc === 3) return new TextDecoder('utf-8').decode(b);
  if (enc === 2) return new TextDecoder('utf-16be').decode(b);
  // 1: UTF-16 with a byte-order mark
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  return new TextDecoder('utf-16le').decode(b);
}

/** End of a null-terminated string in `enc` starting at `from` (UTF-16 ends with two zero bytes). */
function textEnd(enc: number, b: Uint8Array, from: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}

export function parseId3(b: Uint8Array): SongTags {
  if (latin1(b.subarray(0, 3)) !== 'ID3') return {};
  const major = b[3]!;
  if (major < 3 || major > 4) return {};
  const flags = b[5]!;
  const size = syncsafe(b, 6);
  let p = 10;
  if (flags & 0x40) p += major === 4 ? syncsafe(b, 10) : u32be(b, 10) + 4; // extended header
  const end = Math.min(10 + size, b.length);
  const out: SongTags = {};
  while (p + 10 <= end) {
    const id = latin1(b.subarray(p, p + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const len = major === 4 ? syncsafe(b, p + 4) : u32be(b, p + 4);
    const body = b.subarray(p + 10, Math.min(p + 10 + len, end));
    p += 10 + len;
    if (!body.length) continue;
    const enc = body[0]!;
    if (id === 'TIT2' || id === 'TPE1' || id === 'TALB' || id === 'TRCK' || id === 'TPE2') {
      const v = clean(decodeText(enc, body.subarray(1)));
      if (id === 'TIT2') out.title ??= v;
      else if (id === 'TPE1') out.artist ??= v;
      else if (id === 'TPE2') out.artist ??= v;
      else if (id === 'TALB') out.album ??= v;
      else out.trackNo ??= trackNumber(v);
    } else if (id === 'APIC' && !out.cover) {
      const mimeEnd = body.indexOf(0, 1);
      if (mimeEnd < 0) continue;
      let mime = latin1(body.subarray(1, mimeEnd)).toLowerCase();
      if (!mime.includes('/')) mime = `image/${mime || 'jpeg'}`;
      const descEnd = textEnd(enc, body, mimeEnd + 2);
      const data = body.subarray(descEnd + (enc === 1 || enc === 2 ? 2 : 1));
      if (data.length > 16) out.cover = { mime, data: data.slice() };
    }
  }
  return out;
}

// ── Vorbis comments (FLAC, OGG) ───────────────────────────────────────────────
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function parseVorbisComment(b: Uint8Array, start = 0): SongTags {
  const out: SongTags = {};
  let p = start;
  if (p + 4 > b.length) return out;
  p += 4 + u32le(b, p); // vendor
  if (p + 4 > b.length) return out;
  const n = Math.min(u32le(b, p), 1000);
  p += 4;
  const utf8 = new TextDecoder('utf-8');
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = u32le(b, p);
    const s = utf8.decode(b.subarray(p + 4, p + 4 + len));
    p += 4 + len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase();
    const v = clean(s.slice(eq + 1));
    if (k === 'TITLE') out.title ??= v;
    else if (k === 'ARTIST' || k === 'ALBUMARTIST') out.artist ??= v;
    else if (k === 'ALBUM') out.album ??= v;
    else if (k === 'TRACKNUMBER') out.trackNo ??= trackNumber(v);
  }
  return out;
}

export function parseFlac(b: Uint8Array): SongTags {
  if (latin1(b.subarray(0, 4)) !== 'fLaC') return {};
  let p = 4;
  let out: SongTags = {};
  for (;;) {
    if (p + 4 > b.length) break;
    const last = (b[p]! & 0x80) !== 0;
    const type = b[p]! & 0x7f;
    const len = (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!;
    const body = b.subarray(p + 4, p + 4 + len);
    if (type === 4) out = { ...parseVorbisComment(body), cover: out.cover };
    if (type === 6 && !out.cover && body.length > 32) {
      let q = 4;
      const mimeLen = u32be(body, q);
      const mime = latin1(body.subarray(q + 4, q + 4 + mimeLen)).toLowerCase();
      q += 4 + mimeLen;
      q += 4 + u32be(body, q); // description
      q += 16; // width, height, depth, colours
      const dataLen = u32be(body, q);
      const data = body.subarray(q + 4, q + 4 + dataLen);
      if (data.length > 16) out.cover = { mime: mime || 'image/jpeg', data: data.slice() };
    }
    p += 4 + len;
    if (last) break;
  }
  return out;
}

export function parseOgg(b: Uint8Array): SongTags {
  // The comment packet is the second one; for tags of normal size it sits whole in the first pages.
  const s = latin1(b.subarray(0, Math.min(b.length, 131072)));
  const opus = s.indexOf('OpusTags');
  if (opus >= 0) return parseVorbisComment(b, opus + 8);
  const vorbis = s.indexOf('\x03vorbis');
  if (vorbis >= 0) return parseVorbisComment(b, vorbis + 7);
  return {};
}

// ── MP4 / M4A ─────────────────────────────────────────────────────────────────
interface Atom {
  type: string;
  start: number; // where its content begins
  end: number;
}

function atoms(b: Uint8Array, from: number, to: number): Atom[] {
  const out: Atom[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    const type = latin1(b.subarray(p + 4, p + 8));
    let head = 8;
    if (size === 1 && p + 16 <= to) {
      size = u32be(b, p + 12); // 64-bit size: the low half is enough for tags
      head = 16;
    }
    if (size === 0) size = to - p;
    if (size < head) break;
    out.push({ type, start: p + head, end: Math.min(p + size, to) });
    p += size;
  }
  return out;
}

export function parseIlst(b: Uint8Array): SongTags {
  const out: SongTags = {};
  for (const a of atoms(b, 0, b.length)) {
    const data = atoms(b, a.start, a.end).find((x) => x.type === 'data');
    if (!data || data.end - data.start < 8) continue;
    const kind = u32be(b, data.start) & 0xffffff;
    const v = b.subarray(data.start + 8, data.end);
    const str = () => clean(new TextDecoder('utf-8').decode(v));
    if (a.type === '\xa9nam') out.title ??= str();
    else if (a.type === '\xa9ART' || a.type === 'aART') out.artist ??= str();
    else if (a.type === '\xa9alb') out.album ??= str();
    else if (a.type === 'trkn' && v.length >= 4) out.trackNo ??= (v[2]! << 8) | v[3]!;
    else if (a.type === 'covr' && !out.cover && v.length > 16) out.cover = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: v.slice() };
  }
  return out;
}

async function readMp4(file: Blob): Promise<SongTags> {
  // Walk the top-level atoms by their sizes (moov may be at the end) and read only moov.
  let p = 0;
  for (let i = 0; i < 64 && p + 8 <= file.size; i++) {
    const h = await bytes(file, p, p + 16);
    let size = u32be(h, 0);
    const type = latin1(h.subarray(4, 8));
    if (size === 1) size = u32be(h, 12) + u32be(h, 8) * 2 ** 32;
    if (size === 0) size = file.size - p;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > MAX_TAG_BYTES * 4) return {};
      const moov = await bytes(file, p + 8, p + size);
      const udta = atoms(moov, 0, moov.length).find((x) => x.type === 'udta');
      if (!udta) return {};
      const meta = atoms(moov, udta.start, udta.end).find((x) => x.type === 'meta');
      if (!meta) return {};
      // meta is a "full box": 4 bytes of version/flags before its children (QuickTime style has none).
      const skip = latin1(moov.subarray(meta.start + 4, meta.start + 8)) === 'hdlr' ? 0 : 4;
      const ilst = atoms(moov, meta.start + skip, meta.end).find((x) => x.type === 'ilst');
      return ilst ? parseIlst(moov.subarray(ilst.start, ilst.end)) : {};
    }
    p += size;
  }
  return {};
}

// ── File name ─────────────────────────────────────────────────────────────────
/** "03 - Calm_Forest.mp3" → "Calm Forest". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_]+/g, ' ');
  const t = base.replace(/^\s*\d{1,3}\s*[-.)_ ]\s*/, '').replace(/\s+/g, ' ').trim();
  return (t || base.trim() || 'Untitled').slice(0, 200);
}

/** The tags of a song file, by its real type. */
export async function readTags(file: Blob, mime: MediaMime): Promise<SongTags> {
  try {
    if (mime === 'audio/mpeg') {
      const head = await bytes(file, 0, 10);
      if (latin1(head.subarray(0, 3)) !== 'ID3') return {};
      const size = 10 + syncsafe(head, 6);
      return size > MAX_TAG_BYTES ? {} : parseId3(await bytes(file, 0, size));
    }
    if (mime === 'audio/flac') return parseFlac(await bytes(file, 0, MAX_TAG_BYTES));
    if (mime === 'audio/ogg') return parseOgg(await bytes(file, 0, 131072));
    if (mime === 'audio/mp4') return await readMp4(file);
  } catch {
    // A damaged tag must never stop the upload: the file name is used instead.
  }
  return {};
}

/** The real type from the first bytes (null: not a song this speaker can play). */
export async function sniffFile(file: Blob): Promise<MediaMime | null> {
  return sniffAudio(await bytes(file, 0, 16));
}
