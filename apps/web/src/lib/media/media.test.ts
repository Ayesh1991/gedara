import { describe, expect, it } from 'vitest';
import { sniffAudio } from '@media/protocol';
import { dominantColours, forGlow } from './palette';
import { elapsedAt, formatLength, formatTime, fraction, sleepMinutesLeft } from './progress';
import { parseFlac, parseId3, parseIlst, parseOgg, titleFromFileName } from './tags';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function id3(major: 3 | 4, frames: Array<[string, number[]]>): Uint8Array {
  const body = frames.flatMap(([id, data]) => [...ascii(id), ...(major === 4 ? syncsafe(data.length) : be32(data.length)), 0, 0, ...data]);
  return new Uint8Array([...ascii('ID3'), major, 0, 0, ...syncsafe(body.length + 20), ...body, ...new Array(20).fill(0)]);
}

describe('sniffAudio', () => {
  it('knows songs by their first bytes, not their names', () => {
    expect(sniffAudio(new Uint8Array(ascii('ID3\x04\0\0')))).toBe('audio/mpeg');
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg');
    expect(sniffAudio(new Uint8Array(ascii('fLaC\0\0')))).toBe('audio/flac');
    expect(sniffAudio(new Uint8Array(ascii('OggS\0\x02')))).toBe('audio/ogg');
    expect(sniffAudio(new Uint8Array(ascii('RIFF\x10\0\0\0WAVEfmt ')))).toBe('audio/wav');
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0x20, ...ascii('ftypM4A ')]))).toBe('audio/mp4');
  });
  it('refuses everything else', () => {
    expect(sniffAudio(new Uint8Array(ascii('%PDF-1.7')))).toBeNull();
    expect(sniffAudio(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // a JPEG
    expect(sniffAudio(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBeNull(); // ADTS AAC, not MP3
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0x20, ...ascii('ftypqt  ')]))).toBeNull(); // a movie
  });
});

describe('ID3v2', () => {
  it('reads v2.4 UTF-8 text and the cover', () => {
    const cover = [0xff, 0xd8, ...new Array(30).fill(7)];
    const tags = parseId3(
      id3(4, [
        ['TIT2', [3, ...new TextEncoder().encode('වැස්ස Rain')]],
        ['TPE1', [3, ...ascii('Nature')]],
        ['TALB', [0, ...ascii('Calm')]],
        ['TRCK', [0, ...ascii('3/12')]],
        ['APIC', [0, ...ascii('image/jpeg'), 0, 3, ...ascii('front'), 0, ...cover]],
      ]),
    );
    expect(tags).toMatchObject({ title: 'වැස්ස Rain', artist: 'Nature', album: 'Calm', trackNo: 3 });
    expect(tags.cover?.mime).toBe('image/jpeg');
    expect([...tags.cover!.data]).toEqual(cover);
  });
  it('reads v2.3 UTF-16 with a byte-order mark', () => {
    const utf16 = [0xff, 0xfe, ...[...'Forest'].flatMap((c) => [c.charCodeAt(0), 0])];
    expect(parseId3(id3(3, [['TIT2', [1, ...utf16]]])).title).toBe('Forest');
  });
  it('ignores what isn\'t ID3', () => {
    expect(parseId3(new Uint8Array(ascii('fLaC')))).toEqual({});
  });
});

describe('FLAC, OGG, M4A', () => {
  const comment = (pairs: string[]) => {
    const enc = new TextEncoder();
    const items = pairs.flatMap((p) => [...le32(enc.encode(p).length), ...enc.encode(p)]);
    return [...le32(4), ...ascii('test'), ...le32(pairs.length), ...items];
  };
  it('reads a FLAC VORBIS_COMMENT block', () => {
    const block = comment(['TITLE=Waves', 'ARTIST=Sea', 'ALBUM=Shore', 'TRACKNUMBER=7']);
    const streaminfo = new Array(34).fill(0);
    const flac = new Uint8Array([...ascii('fLaC'), 0, 0, 0, 34, ...streaminfo, 0x84, 0, (block.length >> 8) & 255, block.length & 255, ...block]);
    expect(parseFlac(flac)).toMatchObject({ title: 'Waves', artist: 'Sea', album: 'Shore', trackNo: 7 });
  });
  it('reads Opus tags from the first pages', () => {
    const ogg = new Uint8Array([...ascii('OggS'), ...new Array(30).fill(0), ...ascii('OpusTags'), ...comment(['title=Night'])]);
    expect(parseOgg(ogg).title).toBe('Night');
  });
  it('reads an M4A ilst', () => {
    const atom = (type: number[], body: number[]) => [...be32(body.length + 8), ...type, ...body];
    const data = (kind: number, v: number[]) => atom(ascii('data'), [...be32(kind), 0, 0, 0, 0, ...v]);
    const ilst = [
      ...atom([0xa9, ...ascii('nam')], data(1, ascii('Dawn'))),
      ...atom([0xa9, ...ascii('ART')], data(1, ascii('Birds'))),
      ...atom(ascii('trkn'), data(0, [0, 0, 0, 5, 0, 9])),
    ];
    expect(parseIlst(new Uint8Array(ilst))).toMatchObject({ title: 'Dawn', artist: 'Birds', trackNo: 5 });
  });
});

describe('titleFromFileName', () => {
  it.each([
    ['03 - Calm_Forest.mp3', 'Calm Forest'],
    ['rain.flac', 'rain'],
    ['12. Night Sky.m4a', 'Night Sky'],
    ['2024.mp3', '2024'],
  ])('%s → %s', (name, title) => expect(titleFromFileName(name)).toBe(title));
});

describe('progress', () => {
  const at = '2026-10-15T10:00:00.000Z';
  const t0 = Date.parse(at);
  it('runs on while playing, stops at the end', () => {
    const p = { state: 'playing' as const, elapsed_s: 10, duration_s: 60, at };
    expect(elapsedAt(p, t0 + 5_000)).toBe(15);
    expect(elapsedAt(p, t0 + 500_000)).toBe(60);
    expect(fraction(p, t0 + 20_000)).toBe(0.5);
  });
  it('stands still when paused', () => {
    expect(elapsedAt({ state: 'paused', elapsed_s: 10, duration_s: 60, at }, t0 + 9_000)).toBe(10);
  });
  it('formats times and lengths', () => {
    expect(formatTime(75)).toBe('1:15');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(null)).toBe('–:––');
    expect(formatLength(38 * 60, { h: 'h', min: 'min' })).toBe('38 min');
    expect(formatLength(72 * 60, { h: 'h', min: 'min' })).toBe('1 h 12 min');
  });
  it('counts sleep minutes to the nearest minute, never below 1', () => {
    expect(sleepMinutesLeft(new Date(t0 + 30 * 60_000 + 14_000).toISOString(), t0)).toBe(30);
    expect(sleepMinutesLeft(new Date(t0 + 91_000).toISOString(), t0)).toBe(2);
    expect(sleepMinutesLeft(new Date(t0 + 10_000).toISOString(), t0)).toBe(1);
    expect(sleepMinutesLeft(new Date(t0 - 1).toISOString(), t0)).toBeNull();
    expect(sleepMinutesLeft(null, t0)).toBeNull();
  });
});

describe('palette', () => {
  const pixels = (colours: Array<[number, number, number, number]>) =>
    colours.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());
  it('prefers vivid colours over large grey areas and keeps them distinct', () => {
    const out = dominantColours(pixels([[128, 128, 128, 500], [20, 120, 220, 200], [24, 118, 222, 50], [230, 60, 40, 150]]), 3);
    expect(out[0]).toEqual([21, 120, 220]); // the two near-identical blues count as one
    expect(out).toContainEqual([230, 60, 40]);
    expect(out.length).toBe(3);
  });
  it('keeps glow colours dark enough for white text', () => {
    const [r, g, b] = forGlow([250, 250, 240]);
    expect((Math.max(r, g, b) + Math.min(r, g, b)) / 510).toBeLessThanOrEqual(0.551);
    expect(forGlow([0, 0, 0])).toEqual([71, 71, 71]);
  });
});
