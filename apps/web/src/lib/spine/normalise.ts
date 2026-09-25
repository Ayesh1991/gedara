// Printed bill name → lookup key. Exactly `private.bill_name_norm` (migration 28): lower-case,
// ASCII punctuation to spaces, single spaces, trimmed. Non-ASCII letters (Sinhala) stay as they are.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/g;

export function billNameNorm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(ASCII_PUNCT, ' ').replace(/\s+/g, ' ').trim();
}
