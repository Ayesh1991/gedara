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
