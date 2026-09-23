// Epson L3110 A4 sticker sheets (MASTER_PLAN §7c, template `a4-6x9`). Every dimension is a setting,
// in millimetres; offsets come from the calibration page. Geometry is pure so it can be tested.

export interface SheetProfile {
  orientation: 'landscape' | 'portrait';
  rows: number;
  cols: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  gutterX: number;
  gutterY: number;
  offsetX: number;
  offsetY: number;
  qrMm: number;
}

/** Standard A4 sticker paper, 6 × 9 = 54, landscape (cells ≈ 33 × 35 mm). */
export const DEFAULT_PROFILE: SheetProfile = {
  orientation: 'landscape',
  rows: 6,
  cols: 9,
  marginTop: 0,
  marginRight: 0,
  marginBottom: 0,
  marginLeft: 0,
  gutterX: 0,
  gutterY: 0,
  offsetX: 0,
  offsetY: 0,
  qrMm: 24,
};

export interface Rect {
  x: number; // from the left edge, mm
  y: number; // from the TOP edge, mm
  w: number;
  h: number;
}

export function pageSize(p: Pick<SheetProfile, 'orientation'>) {
  return p.orientation === 'landscape' ? { w: 297, h: 210 } : { w: 210, h: 297 };
}

export function cellSize(p: SheetProfile) {
  const page = pageSize(p);
  return {
    w: (page.w - p.marginLeft - p.marginRight - p.gutterX * (p.cols - 1)) / p.cols,
    h: (page.h - p.marginTop - p.marginBottom - p.gutterY * (p.rows - 1)) / p.rows,
  };
}

export function cellRect(p: SheetProfile, row: number, col: number): Rect {
  const { w, h } = cellSize(p);
  return {
    x: p.marginLeft + col * (w + p.gutterX) + p.offsetX,
    y: p.marginTop + row * (h + p.gutterY) + p.offsetY,
    w,
    h,
  };
}

export interface Placement<T> {
  item: T;
  page: number;
  row: number;
  col: number;
  rect: Rect;
}

/**
 * Places items row by row. The first sheet starts at (startRow, startCol) so a half-used sticker
 * sheet isn't wasted; later sheets start at the top-left.
 */
export function layoutSheets<T>(p: SheetProfile, items: T[], startRow = 0, startCol = 0): Placement<T>[] {
  const perPage = p.rows * p.cols;
  const first = Math.min(Math.max(0, startRow), p.rows - 1) * p.cols + Math.min(Math.max(0, startCol), p.cols - 1);
  return items.map((item, i) => {
    const slot = first + i;
    const page = Math.floor(slot / perPage);
    const inPage = slot % perPage;
    const row = Math.floor(inPage / p.cols);
    const col = inPage % p.cols;
    return { item, page, row, col, rect: cellRect(p, row, col) };
  });
}

/** QR edge length that fits the cell with room for two text lines below. */
export function qrSizeFor(p: SheetProfile): number {
  const { w, h } = cellSize(p);
  return Math.max(8, Math.min(p.qrMm, w - 3, h - 9));
}
