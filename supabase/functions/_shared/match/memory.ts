// Categories Gedara knows before anyone teaches it (Didula's choices, 2026-10-22). Shared by the web
// app (lib/match/memory.ts) and the match-agent run, so both suggest the same.
import { billNameNorm } from './normalise.ts';

export interface CategoryLite {
  id: string;
  parent_id: string | null;
  key: string | null;
  name: string;
}

export function builtInCategory(categories: CategoryLite[], text: string | null | undefined): string | null {
  if (billNameNorm(text) === 'etc top up') {
    const transport = categories.find((c) => c.parent_id === null && c.key === 'transport');
    if (!transport) return null;
    const subs = categories.filter((c) => c.parent_id === transport.id);
    return (subs.find((c) => /toll/i.test(c.name)) ?? subs.find((c) => c.name === 'Other transport'))?.id ?? null;
  }
  return null;
}

// ── Payee → category (Phase 9b.1) ────────────────────────────────────────────
// A payee's own confirmation ("SLT bill", "Dialog reload", "LECO electricity", "Cargills") says what a
// payment was for. The household's choices (payee_category) win; these defaults fill the rest.
const PAYEE_DEFAULTS: Array<{ payee: RegExp; top: string; sub: RegExp }> = [
  { payee: /^slt\b(?!.*mobitel)/, top: 'services', sub: /^internet$/i },
  { payee: /\b(mobitel|dialog|airtel|hutch)\b/, top: 'services', sub: /mobile|telephone/i },
  { payee: /\bleco\b|\bceb\b|electricity/, top: 'energy', sub: /electric/i },
  { payee: /\bcargills\b|\bkeells\b|\bspar\b|\bglomark\b|\barpico\b/, top: 'grocery', sub: /^other grocery$/i },
];

/** The payees Gedara reads confirmations from (what the parsers call them), for Settings › Matching. */
export const KNOWN_PAYEES = ['SLT bill', 'LECO electricity', 'Mobitel recharge', 'Dialog plan', 'Dialog reload', 'Cargills'] as const;

export function payeeCategory(
  categories: CategoryLite[],
  overrides: ReadonlyMap<string, string>,
  payee: string | null | undefined,
): string | null {
  const key = billNameNorm(payee);
  if (!key) return null;
  const own = overrides.get(key);
  if (own && categories.some((c) => c.id === own)) return own;
  const rule = PAYEE_DEFAULTS.find((d) => d.payee.test(key));
  if (!rule) return null;
  const top = categories.find((c) => c.parent_id === null && c.key === rule.top);
  if (!top) return null;
  return categories.find((c) => c.parent_id === top.id && rule.sub.test(c.name))?.id ?? top.id;
}
