/** A lot label's text line (≤ 10 characters, §7c sq20-lot): "EXP 26-10" or "BB 26-10"; null without a date. */
export function lotDueText(due: string | null | undefined, dueType: string | null | undefined): string | null {
  const m = /^\d{2}(\d{2})-(\d{2})/.exec(due ?? '');
  if (!m || dueType === 'none') return null;
  return `${dueType === 'expiry' ? 'EXP' : 'BB'} ${m[1]}-${m[2]}`;
}
