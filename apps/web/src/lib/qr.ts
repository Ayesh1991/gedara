import QRCode from 'qrcode';

// QR generation for labels (MASTER_PLAN §7c). We only take the module matrix from `qrcode` and draw
// it ourselves (SVG on screen, vector squares in the A4 PDF, whole dots on the 203 dpi thermal
// label), so nothing is ever scaled after rendering.

export interface QrMatrix {
  size: number;
  version: number;
  /** true = dark module */
  dark: (row: number, col: number) => boolean;
}

function toMatrix(qr: QRCode.QRCode): QrMatrix {
  const { size, data } = qr.modules;
  return { size, version: qr.version, dark: (r, c) => data[r * size + c] === 1 };
}

/**
 * Raw label code (`HL:LOC:7K2P9Q`) for 20 mm labels: alphanumeric mode, version 1, EC level M
 * (21 × 21). Throws if the text doesn't fit — never silently grow the symbol on a tiny label.
 */
export function rawCodeQr(code: string): QrMatrix {
  if (!/^[0-9A-Z $%*+\-./:]+$/.test(code)) throw new Error(`not QR-alphanumeric: ${code}`);
  const qr = QRCode.create([{ data: code, mode: 'alphanumeric' }], { version: 1, errorCorrectionLevel: 'M' });
  return toMatrix(qr);
}

/** URL form for A4 labels (byte mode, EC M, smallest version that fits). */
export function urlQr(url: string): QrMatrix {
  return toMatrix(QRCode.create(url, { errorCorrectionLevel: 'M' }));
}

/** Horizontal runs of dark modules: fewer shapes than one square per module. */
export function darkRuns(m: QrMatrix): Array<{ row: number; col: number; len: number }> {
  const runs: Array<{ row: number; col: number; len: number }> = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.dark(r, c)) c++;
      runs.push({ row: r, col: start, len: c - start });
    }
  }
  return runs;
}

/** SVG path data in module units (viewBox `0 0 size size`); crisp with shape-rendering=crispEdges. */
export function qrSvgPath(m: QrMatrix): string {
  return darkRuns(m)
    .map(({ row, col, len }) => `M${col} ${row}h${len}v1h-${len}z`)
    .join('');
}
