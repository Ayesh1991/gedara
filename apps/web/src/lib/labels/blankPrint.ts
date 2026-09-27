// Printing blank sheets (Phase 7b): A4 PDFs through buildSheetPdf (each label in its own slot, so a
// reprint lands in the same cells) and NIIMBOT 20 / 10 mm PNGs in one zip. Off production every
// label says TEST: codes live in the database they were made in, and a staging code stuck on a real
// box would never open anything in the real app.
import { labelUrl } from '../codes';
import { rawCodeQr } from '../qr';
import { composeSq10, composeSq20, encodePng1bit, rasterizeText, sq20TextArea } from './bitmap';
import type { FontBytes } from './pdf';
import type { SheetProfile } from './sheet';
import { blankLabelText, type BlankFormat } from './tags';

export interface PrintSheet {
  sheetNo: number;
  format: BlankFormat;
  tags: Array<{ code: string; slot: number }>;
}

/** A4 (URL QR + "S7 · 12") or A4 mini (raw-code 10 mm QR only). */
export async function blankSheetPdf(opts: {
  profile: SheetProfile;
  sheets: PrintSheet[];
  baseUrl: string;
  test: boolean;
  fonts?: FontBytes;
}): Promise<Uint8Array> {
  const { buildSheetPdf } = await import('./pdf');
  const mini = opts.sheets.every((s) => s.format === 'a4mini');
  return buildSheetPdf({
    profile: opts.profile,
    labels: [],
    mini,
    fonts: opts.fonts,
    sheets: opts.sheets.map((s) =>
      s.tags.map((tag) => ({
        slot: tag.slot,
        code: tag.code,
        url: labelUrl(tag.code, opts.baseUrl),
        name: opts.test ? `TEST ${blankLabelText(s.sheetNo, tag.slot)}` : blankLabelText(s.sheetNo, tag.slot),
        crumb: opts.test ? 'staging · do not use' : 'Gedara',
      })),
    ),
  });
}

/** NIIMBOT PNGs (203 dpi, 1-bit), one per label, named by sheet and position, in one zip. */
export async function blankPngZip(sheets: PrintSheet[], test: boolean): Promise<Uint8Array> {
  const { zipSync } = await import('fflate');
  await document.fonts.load('700 30px "Space Grotesk"').catch(() => undefined);
  const area = sq20TextArea();
  const files: Record<string, Uint8Array> = {};
  for (const s of sheets) {
    for (const tag of s.tags) {
      const text = test ? 'TEST' : blankLabelText(s.sheetNo, tag.slot, true);
      const bm =
        s.format === 'sq10'
          ? composeSq10(rawCodeQr(tag.code))
          : composeSq20(rawCodeQr(tag.code), rasterizeText(text, area.width, area.height));
      const pos = String(tag.slot + 1).padStart(3, '0');
      files[`sheet-${s.sheetNo}/S${s.sheetNo}-${pos}-${tag.code.replace(/:/g, '-')}.png`] = await encodePng1bit(bm);
    }
  }
  // PNGs are already compressed: store them.
  return zipSync(files, { level: 0 });
}
