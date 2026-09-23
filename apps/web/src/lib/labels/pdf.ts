import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { darkRuns, urlQr } from '../qr';
import { cellRect, layoutSheets, pageSize, qrSizeFor, type Rect, type SheetProfile } from './sheet';

// A4 label + calibration PDFs (pdf-lib, loaded only on the Labels screen).

// ── PDF ───────────────────────────────────────────────────────────────────────

const PT = 72 / 25.4;

export interface SheetLabel {
  url: string;
  name: string;
  crumb: string;
}

/** Keep only characters the embedded font can draw (Sinhala etc. would print as boxes). */
function drawable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text].map((ch) => (set.has(ch.codePointAt(0)!) ? ch : '?')).join('');
}

function fit(font: PDFFont, text: string, size: number, maxW: number): string {
  let t = drawable(font, text);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return drawable(font, `${t.trimEnd()}…`);
}

function drawCell(page: PDFPage, pageH: number, rect: Rect, label: SheetLabel, qrMm: number, fonts: Fonts) {
  const m = urlQr(label.url);
  const mod = qrMm / m.size;
  const qx = rect.x + (rect.w - qrMm) / 2;
  const qy = rect.y + 1.5;
  for (const run of darkRuns(m)) {
    page.drawRectangle({
      x: (qx + run.col * mod) * PT,
      y: (pageH - (qy + (run.row + 1) * mod)) * PT,
      // A hair of overlap so adjacent runs never leave a white seam in the printer driver.
      width: run.len * mod * PT + 0.05,
      height: mod * PT + 0.05,
      color: rgb(0, 0, 0),
    });
  }
  const textW = (rect.w - 2) * PT;
  const cx = (rect.x + rect.w / 2) * PT;
  const nameY = qy + qrMm + 3.2;
  const name = fit(fonts.bold, label.name, 7, textW);
  page.drawText(name, {
    x: cx - fonts.bold.widthOfTextAtSize(name, 7) / 2,
    y: (pageH - nameY) * PT,
    size: 7,
    font: fonts.bold,
  });
  if (label.crumb) {
    const crumb = fit(fonts.regular, label.crumb, 5, textW);
    page.drawText(crumb, {
      x: cx - fonts.regular.widthOfTextAtSize(crumb, 5) / 2,
      y: (pageH - nameY - 2.4) * PT,
      size: 5,
      font: fonts.regular,
      color: rgb(0.3, 0.3, 0.3),
    });
  }
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Font bytes (WOFF/TTF). Omitted = Helvetica (tests, or if the font fails to load). */
export interface FontBytes {
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}

async function embedFonts(doc: PDFDocument, bytes?: FontBytes): Promise<Fonts> {
  if (bytes) {
    doc.registerFontkit(fontkit);
    return {
      regular: await doc.embedFont(bytes.regular, { subset: true }),
      bold: await doc.embedFont(bytes.bold, { subset: true }),
    };
  }
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

export async function buildSheetPdf(opts: {
  profile: SheetProfile;
  labels: SheetLabel[];
  startRow?: number;
  startCol?: number;
  fonts?: FontBytes;
}): Promise<Uint8Array> {
  const { profile } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle('Gedara labels');
  doc.setCreator('Gedara');
  const fonts = await embedFonts(doc, opts.fonts);
  const size = pageSize(profile);
  const qrMm = qrSizeFor(profile);
  const pages: PDFPage[] = [];
  for (const pl of layoutSheets(profile, opts.labels, opts.startRow, opts.startCol)) {
    while (pages.length <= pl.page) pages.push(doc.addPage([size.w * PT, size.h * PT]));
    drawCell(pages[pl.page]!, size.h, pl.rect, pl.item, qrMm, fonts);
  }
  return doc.save();
}

/** Plain-paper page with every cell's border and centre cross, to line up against a sticker sheet. */
export async function buildCalibrationPdf(profile: SheetProfile, caption: string, fonts?: FontBytes): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Gedara calibration');
  const f = await embedFonts(doc, fonts);
  const size = pageSize(profile);
  const page = doc.addPage([size.w * PT, size.h * PT]);
  const line = { thickness: 0.4, color: rgb(0, 0, 0) };
  for (let r = 0; r < profile.rows; r++) {
    for (let c = 0; c < profile.cols; c++) {
      const rect = cellRect(profile, r, c);
      page.drawRectangle({
        x: rect.x * PT,
        y: (size.h - rect.y - rect.h) * PT,
        width: rect.w * PT,
        height: rect.h * PT,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.4,
      });
      const cx = rect.x + rect.w / 2;
      const cy = size.h - (rect.y + rect.h / 2);
      page.drawLine({ start: { x: (cx - 3) * PT, y: cy * PT }, end: { x: (cx + 3) * PT, y: cy * PT }, ...line });
      page.drawLine({ start: { x: cx * PT, y: (cy - 3) * PT }, end: { x: cx * PT, y: (cy + 3) * PT }, ...line });
    }
  }
  const text = drawable(f.regular, caption);
  page.drawText(text, {
    x: (size.w / 2) * PT - f.regular.widthOfTextAtSize(text, 7) / 2,
    y: (size.h / 2) * PT + 12,
    size: 7,
    font: f.regular,
    color: rgb(0.35, 0.35, 0.35),
  });
  return doc.save();
}
