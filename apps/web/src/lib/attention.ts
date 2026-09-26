// The Attention feed (MASTER_PLAN §4 row 7): items come from the database (attention_feed, migration
// 46) — the same definition the 07:00 push uses. This file only decides where each item leads and
// how it is coloured. Pure: no Supabase import.

export const ATTENTION_KINDS = [
  'expired',
  'best_before_passed',
  'due_soon',
  'below_min',
  'runs_out',
  'bill_due',
  'insurance_due',
  'warranty_ending',
  'service_due',
  'things_pending',
  'sms_review',
  'scan_waiting',
  'backup_due',
  'budget_over',
  'budget_near',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const SEVERITIES = ['red', 'amber', 'cyan', 'violet', 'teal'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AttentionItem {
  item_key: string;
  kind: AttentionKind;
  severity: Severity;
  entity_type: string | null;
  entity_id: string | null;
  title: string | null;
  due_on: string | null;
  days_left: number | null;
  amount: number | null;
  qty: number | null;
  unit: string | null;
  extra: Record<string, unknown>;
}

/** Status colours never change with the theme (CLAUDE.md rule 11). */
export const SEVERITY_TONE: Record<Severity, 'red' | 'caution' | 'due' | 'info' | 'teal'> = {
  red: 'red',
  amber: 'caution',
  cyan: 'due',
  violet: 'info',
  teal: 'teal',
};

export const SEVERITY_RANK: Record<Severity, number> = { red: 0, amber: 1, cyan: 2, violet: 3, teal: 4 };

/** A router target: spread into <Link> (to + params + search). */
export interface Target {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
}

export function attentionTarget(i: AttentionItem): Target {
  switch (i.kind) {
    case 'expired':
    case 'best_before_passed':
    case 'due_soon':
    case 'below_min':
    case 'runs_out':
      return i.entity_id ? { to: '/pantry/$productId', params: { productId: i.entity_id } } : { to: '/pantry' };
    case 'bill_due':
    case 'insurance_due':
      return { to: '/money/recurring', search: i.entity_id ? { pay: i.entity_id } : {} };
    case 'warranty_ending':
    case 'service_due':
      return i.entity_id ? { to: '/things/$assetId', params: { assetId: i.entity_id } } : { to: '/things' };
    case 'things_pending':
      return { to: '/things/pending' };
    case 'sms_review':
      return { to: '/money/inbox' };
    case 'scan_waiting':
      return { to: '/money/import', search: { tab: 'drive' } };
    case 'backup_due':
      return { to: '/settings/export' };
    case 'budget_over':
    case 'budget_near': {
      const month = typeof i.extra.month === 'string' ? i.extra.month : undefined;
      return { to: '/insights/$area', params: { area: 'spend' }, search: { cat: i.entity_id ?? undefined, from: month, to: month } };
    }
  }
}

/** Only items this app knows how to show (a newer database may add kinds first). */
export function knownItems(rows: AttentionItem[]): AttentionItem[] {
  return rows.filter((r) => (ATTENTION_KINDS as readonly string[]).includes(r.kind));
}

/** Group for the /attention page: most urgent colour first, keeping the database's order inside. */
export function groupBySeverity(items: AttentionItem[]): [Severity, AttentionItem[]][] {
  const groups = new Map<Severity, AttentionItem[]>();
  for (const i of items) groups.set(i.severity, [...(groups.get(i.severity) ?? []), i]);
  return [...groups.entries()].sort((a, b) => SEVERITY_RANK[a[0]] - SEVERITY_RANK[b[0]]);
}

/** "Hide" choices → hidden_until (null = until it changes). */
export type HideChoice = 'tomorrow' | 'week' | 'change';
export function hiddenUntil(choice: HideChoice, today: string): string | null {
  if (choice === 'change') return null;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (choice === 'tomorrow' ? 1 : 7));
  return d.toISOString().slice(0, 10);
}
