// The daily notification's text, from the top attention items (private.attention_items, migration 46).
// English only for now (the app's i18n lives in the browser; Sinhala comes later). No imports.

export type DigestItem = {
  kind: string;
  severity: string;
  title: string | null;
  days_left: number | null;
  qty: number | string | null;
  amount?: number | string | null;
};

function when(days: number | null): string {
  if (days === null) return '';
  if (days < -1) return `${-days} days ago`;
  if (days === -1) return 'yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function itemPhrase(i: DigestItem): string {
  const t = i.title ?? '';
  const d = i.days_left;
  const n = Number(i.qty ?? 0);
  switch (i.kind) {
    case 'expired':
      return `${t} has expired`;
    case 'best_before_passed':
      return `${t} is past best-before`;
    case 'due_soon':
      return `${t} is due ${when(d)}`;
    case 'below_min':
      return `${t} is running low`;
    case 'runs_out':
      return `${t} runs out ${when(d)}`;
    case 'bill_due':
      return d !== null && d < 0 ? `${t} is overdue` : `${t} is due ${when(d)}`;
    case 'insurance_due':
      return d !== null && d < 0 ? `${t} renewal is overdue` : `${t} renewal is due ${when(d)}`;
    case 'warranty_ending':
      return `${t} warranty ends ${when(d)}`;
    case 'service_due':
      return d !== null && d < 0 ? `${t} service is overdue` : `${t} service is due ${when(d)}`;
    case 'things_pending':
      return n === 1 ? '1 thing to enter' : `${n} things to enter`;
    case 'sms_review':
      return n === 1 ? '1 bank alert to review' : `${n} bank alerts to review`;
    case 'budget_over':
      return `${t} budget is over`;
    case 'budget_near':
      return `${t} budget is almost used`;
    default:
      return t;
  }
}

export type DigestMessage = { title: string; body: string; url: string; tag: string; count: number };

export function digestMessage(total: number, items: DigestItem[]): DigestMessage {
  const shown = items.slice(0, 3).map(itemPhrase).filter(Boolean);
  const more = total - shown.length;
  return {
    title: total === 1 ? '1 thing needs attention' : `${total} things need attention`,
    body: shown.join(' · ') + (more > 0 ? ` · +${more} more` : ''),
    url: '/attention',
    tag: 'gedara-attention',
    count: total,
  };
}
