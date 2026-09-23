// Gedara label codes (MASTER_PLAN §3.8): `HL:<KIND>:<6 Crockford base32>`.
// Small labels carry the raw code; A4 labels carry `<base>/s/<code>` so a phone camera deep-links.
// The resolver accepts both, plus what cameras and USB scanners do to them (case, whitespace,
// URL-encoded colons, Crockford look-alike letters).

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export type CodeKind = 'loc' | 'prd' | 'ast' | 'lot';
const PREFIX_TO_KIND: Record<string, CodeKind> = { LOC: 'loc', PRD: 'prd', AST: 'ast', LOT: 'lot' };

export type ParsedScan =
  | { kind: CodeKind; code: string }
  | { kind: 'ean'; digits: string }
  | { kind: 'grocy'; raw: string }
  | { kind: 'unknown'; raw: string };

/** Crockford decoding rules: O→0, I/L→1 (U is never emitted, so it stays invalid). */
function normaliseBody(body: string): string {
  return body.replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function validGtin(digits: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
  const nums = [...digits].map(Number);
  const check = nums.pop()!;
  const sum = nums.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function parseScan(input: string): ParsedScan {
  let raw = input.trim();
  if (!raw) return { kind: 'unknown', raw };

  // URL form: take whatever follows /s/ (host-independent, so an old domain still resolves).
  const url = /\/s\/([^?#\s]+)/i.exec(raw);
  if (url) {
    try {
      raw = decodeURIComponent(url[1]!);
    } catch {
      raw = url[1]!;
    }
  }

  if (/^grcy:/i.test(raw)) return { kind: 'grocy', raw };

  const upper = raw.toUpperCase().replace(/\s+/g, '');
  const m = /^HL[:;]([A-Z]{3})[:;]([0-9A-Z]{6})$/.exec(upper);
  if (m) {
    const kind = PREFIX_TO_KIND[m[1]!];
    const body = normaliseBody(m[2]!);
    if (kind && CODE_BODY.test(body)) return { kind, code: `HL:${m[1]}:${body}` };
    return { kind: 'unknown', raw };
  }

  if (/^\d{8,14}$/.test(upper) && validGtin(upper)) return { kind: 'ean', digits: upper };
  return { kind: 'unknown', raw };
}

/** URL printed on A4 labels. `base` is VITE_PUBLIC_BASE_URL (no custom domain, §7d). */
export function labelUrl(code: string, base: string): string {
  return `${base.replace(/\/+$/, '')}/s/${code}`;
}

/** Short human text for a label's single line (NIIMBOT: ≤ 10 chars). */
export function shortLabelText(name: string, max = 10): string {
  const clean = name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').trim().toUpperCase();
  return clean.length <= max ? clean : clean.slice(0, max);
}
