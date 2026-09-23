import { describe, expect, it } from 'vitest';
import { rawCodeQr, urlQr, qrSvgPath } from '../qr';
import { buildCalibrationPdf, buildSheetPdf } from './pdf';
import { DEFAULT_PROFILE, cellRect, cellSize, layoutSheets, qrSizeFor } from './sheet';
import { SQ20_DOTS, composeSq20, encodePng1bit, sq20TextArea } from './bitmap';

describe('QR', () => {
  it('fits a raw code into version 1-M (21 × 21) for 20 mm labels', () => {
    const m = rawCodeQr('HL:LOC:7K2P9Q');
    expect(m.version).toBe(1);
    expect(m.size).toBe(21);
    // finder pattern corners are dark
    expect(m.dark(0, 0) && m.dark(0, 20) && m.dark(20, 0)).toBe(true);
  });

  it('refuses text that is not alphanumeric-mode', () => {
    expect(() => rawCodeQr('hl:loc:abc')).toThrow();
  });

  it('encodes the A4 URL form as a small symbol', () => {
    const m = urlQr('https://gedara.vercel.app/s/HL:LOC:7K2P9Q');
    expect(m.version).toBeLessThanOrEqual(3);
    expect(qrSvgPath(m)).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  });
});

describe('A4 sheet geometry', () => {
  it('splits landscape A4 into 6 × 9 cells of 33 × 35 mm', () => {
    expect(cellSize(DEFAULT_PROFILE)).toEqual({ w: 33, h: 35 });
    expect(cellRect(DEFAULT_PROFILE, 5, 8)).toEqual({ x: 264, y: 175, w: 33, h: 35 });
  });

  it('applies margins, gutters and calibration offsets', () => {
    const p = { ...DEFAULT_PROFILE, marginLeft: 5, marginRight: 5, gutterX: 1, offsetX: 0.5, offsetY: -1 };
    const { w } = cellSize(p);
    expect(w).toBeCloseTo((297 - 10 - 8) / 9);
    const r = cellRect(p, 1, 2);
    expect(r.x).toBeCloseTo(5 + 2 * (w + 1) + 0.5);
    expect(r.y).toBeCloseTo(35 - 1);
  });

  it('starts a partial sheet at (row, col) and flows onto new pages', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const placed = layoutSheets(DEFAULT_PROFILE, items, 5, 0); // last row: 9 slots left
    expect(placed[0]).toMatchObject({ page: 0, row: 5, col: 0 });
    expect(placed[8]).toMatchObject({ page: 0, row: 5, col: 8 });
    expect(placed[9]).toMatchObject({ page: 1, row: 0, col: 0 });
  });

  it('keeps the QR inside the cell', () => {
    expect(qrSizeFor(DEFAULT_PROFILE)).toBe(24);
    expect(qrSizeFor({ ...DEFAULT_PROFILE, rows: 10 })).toBeLessThan(24);
  });

  it('builds a label PDF and a calibration PDF', async () => {
    const labels = Array.from({ length: 56 }, (_, i) => ({
      url: `https://gedara.vercel.app/s/HL:LOC:0000${String(i).padStart(2, '0')}`,
      name: `Box ${i}`,
      crumb: 'Store room › Rack 2 › ගෙදර',
    }));
    const pdf = await buildSheetPdf({ profile: DEFAULT_PROFILE, labels });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
    const cal = await buildCalibrationPdf(DEFAULT_PROFILE, 'Gedara calibration · X 0 mm · Y 0 mm');
    expect(new TextDecoder().decode(cal.slice(0, 5))).toBe('%PDF-');
  });
});

describe('NIIMBOT 20 × 20 mm bitmap', () => {
  it('draws the QR in whole 5-dot modules on a 160-dot label', () => {
    const bm = composeSq20(rawCodeQr('HL:LOC:7K2P9Q'), null);
    expect(bm.width).toBe(SQ20_DOTS);
    expect(bm.height).toBe(SQ20_DOTS);
    const x0 = Math.floor((160 - 105) / 2);
    // Top-left finder: 7 modules = 35 dots of black on its first row
    for (let x = x0; x < x0 + 35; x++) expect(bm.bits[8 * 160 + x]).toBe(1);
    expect(bm.bits[8 * 160 + x0 - 1]).toBe(0);
    expect(sq20TextArea().height).toBeGreaterThan(30);
  });

  it('encodes a valid 1-bit PNG', async () => {
    const png = await encodePng1bit(composeSq20(rawCodeQr('HL:LOC:7K2P9Q'), null));
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(160); // IHDR width
    expect(png[24]).toBe(1); // bit depth
    expect(png[25]).toBe(0); // grayscale
  });
});
