// Deterministic fingerprints (CLAUDE.md rule 5). `hash32` and the bill / line formats are ported
// byte-for-byte from ledger v7 (reference/ledger-v7/index.html `hash32`, `billToEntries`), so a bill
// already in the old Sheet gets the same id here and is recognised as a duplicate.

/** djb2 over UTF-16 code units, int32 wrap, unsigned base36 (ledger v7 `hash32`). */
export function hash32(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The fields of a scanned bill that identify it. Numbers stay numbers: `String(4620)` is "4620". */
export interface BillKey {
  invoice_no?: string | null;
  date?: string | null;
  time?: string | null;
  shop?: string | null;
  total?: number | null;
}

/** `b<hash>` of `invoice|date|time|lower(trim(shop))|total` (ledger v7 `billKey`). */
export function billFingerprint(b: BillKey): string {
  const key = [
    b.invoice_no || '',
    (b.date || '').slice(0, 10),
    b.time || '',
    String(b.shop || '').toLowerCase().trim(),
    b.total ?? '',
  ].join('|');
  return 'b' + hash32(key);
}

/** `<bill>-<idx>-<hash(name|amount)>`, idx 0-based (ledger v7 `lineId`). */
export function lineFingerprint(billFp: string, idx: number, name: string | null | undefined, amount: number): string {
  return `${billFp}-${idx}-${hash32(String(name || '') + '|' + String(amount))}`;
}

/** A manual entry: `m<hash>` of what makes it that entry; `~n` when saved again on purpose. */
export function manualFingerprint(
  p: { type: string; date: string; time?: string | null; accountId: string; payee?: string | null; total: number },
  repeat = 1,
): string {
  const key = [p.type, p.date, p.time || '', p.accountId, String(p.payee || '').toLowerCase().trim(), String(p.total)].join('|');
  return 'm' + hash32(key) + (repeat > 1 ? `~${repeat}` : '');
}

/** Old Sheet rows from before ledger v7 fingerprints: `L<hash>` of their (sorted) row ids. */
export function legacyFingerprint(rowIds: string[]): string {
  return 'L' + hash32([...rowIds].sort().join('|'));
}

/** Sheet row id `b<hash>-<idx>-<hash>` → its bill fingerprint and line index. */
export function parseLineId(id: string): { bill: string; idx: number } | null {
  const m = /^(b[0-9a-z]+)-(\d+)-[0-9a-z]+$/.exec(id);
  return m ? { bill: m[1]!, idx: Number(m[2]) } : null;
}
