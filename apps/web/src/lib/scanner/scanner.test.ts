import { describe, expect, it } from 'vitest';
import { cleanScanText, DEFAULT_KEYMAP, ScannerSettings, SyncRequest } from '@scanner/protocol';
import { checkFirmware } from '../scale/espImage';
import { canUndoScan, formatAmount, formatChange, keymapValid, keymapVariants, needsYou, packsLeft, scannerOnline, statusTone } from './format';

describe('scanner amounts', () => {
  it('shows pieces as a plain count and sizes with their unit', () => {
    expect(formatAmount(5, 'pcs')).toBe('5');
    expect(formatAmount(800, 'ml')).toBe('800 ml');
    expect(formatAmount(1500, 'g')).toBe('1.5 kg');
    expect(formatAmount(1000, 'ml')).toBe('1 L');
    expect(formatAmount(-0, 'pcs')).toBe('0');
  });
  it('gives a change its sign, with a real minus', () => {
    expect(formatChange(-1, 'pcs')).toBe('−1');
    expect(formatChange(400, 'ml')).toBe('+400 ml');
    expect(formatChange(0, 'g')).toBe('±0 g');
  });
  it('counts whole packs only for products with a pack size', () => {
    expect(packsLeft(800, 400, true)).toBe(2);
    expect(packsLeft(600, 400, true)).toBe(1.5);
    expect(packsLeft(5, 1, false)).toBeNull();
    expect(packsLeft(null, 400, true)).toBeNull();
  });
});

describe('scan cards', () => {
  it('colours by what happened', () => {
    expect(statusTone('used')).toBe('teal');
    expect(statusTone('unknown')).toBe('info');
    expect(statusTone('held')).toBe('caution');
    expect(statusTone('error')).toBe('red');
    expect(statusTone('checked')).toBe('muted');
  });
  it('knows which scans wait for a person and which can be undone', () => {
    expect(needsYou('unknown')).toBe(true);
    expect(needsYou('bill_guard')).toBe(true);
    expect(needsYou('used')).toBe(false);
    expect(canUndoScan({ status: 'used', undone_at: null, kind: 'scan' })).toBe(true);
    expect(canUndoScan({ status: 'used', undone_at: '2026-11-10T10:00:00Z', kind: 'scan' })).toBe(false);
    expect(canUndoScan({ status: 'checked', undone_at: null, kind: 'scan' })).toBe(false);
    expect(canUndoScan({ status: 'undo', undone_at: null, kind: 'undo' })).toBe(false);
  });
  it('calls a scanner online for 35 minutes after its last heartbeat', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(scannerOnline('2026-11-10T11:30:00Z', now)).toBe(true);
    expect(scannerOnline('2026-11-10T11:00:00Z', now)).toBe(false);
    expect(scannerOnline(null, now)).toBe(false);
  });
});

describe('key maps', () => {
  it('accepts every key exactly once', () => {
    expect(keymapValid(DEFAULT_KEYMAP)).toBe(true);
    expect(keymapValid('1111456B789C*0#D')).toBe(false);
    expect(keymapValid('123A456B789C*0#')).toBe(false);
  });
  it('offers the four ways a ribbon can be plugged in, all valid', () => {
    const v = keymapVariants();
    expect(v[0]!.map).toBe(DEFAULT_KEYMAP);
    expect(v.find((x) => x.id === 'swapped')!.map).toBe('147*2580369#ABCD');
    expect(new Set(v.map((x) => x.map)).size).toBe(4);
    for (const x of v) expect(keymapValid(x.map)).toBe(true);
  });
});

describe('scanner protocol', () => {
  const base = { v: 1, fw: '0.1.0', epoch: 7, boot: 1, up: 1000 };
  it('accepts a scan and an undo', () => {
    const r = SyncRequest.safeParse({
      ...base,
      events: [
        { seq: 1, b: 1, t: 900, type: 'scan', mode: 'use', code: '4792210100125' },
        { seq: 2, b: 1, t: 950, type: 'undo' },
      ],
    });
    expect(r.success).toBe(true);
  });
  it('refuses anything a scanner must not ask for', () => {
    const bad = (e: unknown) => SyncRequest.safeParse({ ...base, events: [e] }).success;
    expect(bad({ seq: 1, b: 1, t: 1, type: 'scan', mode: 'delete', code: '4792210100125' })).toBe(false);
    expect(bad({ seq: 1, b: 1, t: 1, type: 'scan', mode: 'use', code: 'x'.repeat(97) })).toBe(false);
    expect(bad({ seq: 1, b: 1, t: 1, type: 'scan', mode: 'use', code: 'abc\u0007def' })).toBe(false);
    expect(bad({ seq: 1, b: 1, t: 1, type: 'scan', mode: 'use', code: 'සිංහල' })).toBe(false);
    expect(bad({ seq: 1, b: 1, t: 1, type: 'scan', mode: 'use', n: 21, code: '4792210100125' })).toBe(false);
    expect(bad({ seq: 1, b: 1, t: 1, type: 'pay', amount: 100 })).toBe(false);
    expect(SyncRequest.safeParse({ ...base, events: Array.from({ length: 21 }, (_, i) => ({ seq: i, b: 1, t: 1, type: 'undo' })) }).success).toBe(false);
  });
  it('cleans what the scanner module sends', () => {
    expect(cleanScanText('4792210100125\r')).toBe('4792210100125');
    expect(cleanScanText('  HL:PRD:7K2P9Q \r\n')).toBe('HL:PRD:7K2P9Q');
    expect(cleanScanText('')).toBeNull();
    expect(cleanScanText('bad\u0000code')).toBeNull();
    expect(cleanScanText('y'.repeat(200))).toBeNull();
  });
  it('checks settings', () => {
    const ok = { volume: 60, quiet_from: '22:00', quiet_to: '06:00', eye: 'sense', eye_quiet: 'same', mode_s: 30, buzzer: 'passive', bright: 80, night_off: true, keymap: DEFAULT_KEYMAP };
    expect(ScannerSettings.safeParse(ok).success).toBe(true);
    expect(ScannerSettings.safeParse({ ...ok, mode_s: 5 }).success).toBe(false);
    expect(ScannerSettings.safeParse({ ...ok, eye: 'laser' }).success).toBe(false);
  });
});

describe('scanner firmware file', () => {
  function image(chip: number, marker: string, size = 70_000): Uint8Array {
    const b = new Uint8Array(size);
    b[0] = 0xe9;
    b[12] = chip;
    for (let i = 0; i < marker.length; i++) b[1000 + i] = marker.charCodeAt(i);
    return b;
  }
  it('accepts bin-scanner firmware for the ESP32 and reads its version', () => {
    const r = checkFirmware(image(0, 'GEDARA-FW:gedara-bin-scanner:0.1.0:END'), 'scanner');
    expect(r.ok && r.info.version).toBe('0.1.0');
  });
  it('refuses the scale\'s firmware, another chip, and a file too big for a 4 MB board', () => {
    expect(checkFirmware(image(0, 'GEDARA-FW:gedara-kitchen-scale:0.1.6:END'), 'scanner')).toEqual({ ok: false, problem: 'wrong_project' });
    expect(checkFirmware(image(9, 'GEDARA-FW:gedara-bin-scanner:0.1.0:END'), 'scanner')).toEqual({ ok: false, problem: 'wrong_chip' });
    expect(checkFirmware(image(0, 'GEDARA-FW:gedara-bin-scanner:0.1.0:END', 0x1c0001), 'scanner')).toEqual({ ok: false, problem: 'too_large' });
    expect(checkFirmware(image(0, 'GEDARA-FW:gedara-bin-scanner:0.1.0:END'))).toEqual({ ok: false, problem: 'wrong_chip' });
  });
});
