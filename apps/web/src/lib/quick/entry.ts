// Quick spend (Phase 12): turning a tap into the op that waits in the outbox. Everything that
// identifies the entry is fixed here, at the tap: its id, its time and its deterministic
// fingerprint (rule 5), so sending it late or twice gives the very same entry.
import { hash32, manualFingerprint } from '@scan/fingerprint';
import type { SpendOp } from '../offline/outbox';

/** 'YYYY-MM-DD' and 'HH:MM:SS' of an instant in the household's timezone (what the database derives too). */
export function localStamp(timeZone: string, at: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone,
  }).format(at);
  return { date, time };
}

export interface SpendInput {
  householdId: string;
  userId: string;
  timeZone: string;
  entry: 'expense' | 'handover';
  tileId: string | null;
  /** The tile's name as shown. */
  name: string;
  categoryId: string | null;
  amount: number;
  /** The wallet the fingerprint is made with; `explicit` = the person chose another account for this entry. */
  accountId: string;
  explicitAccount?: boolean;
  toAccountId?: string | null;
  note?: string | null;
  now?: Date;
  opId?: string;
}

export function buildSpend(i: SpendInput): SpendOp {
  const at = i.now ?? new Date();
  const { date, time } = localStamp(i.timeZone, at);
  const type = i.entry === 'handover' ? 'transfer' : 'expense';
  return {
    kind: 'spend',
    op_id: i.opId ?? crypto.randomUUID(),
    household_id: i.householdId,
    user_id: i.userId,
    client_at: at.toISOString(),
    label: `${i.name} ${i.amount}`,
    state: 'queued',
    immediate: false,
    entry: i.entry,
    tile_id: i.tileId,
    name: i.name,
    category_id: i.entry === 'handover' ? null : i.categoryId,
    amount: i.amount,
    account_id: i.explicitAccount ? i.accountId : null,
    to_account_id: i.entry === 'handover' ? (i.toAccountId ?? null) : null,
    fingerprint: manualFingerprint({ type, date, time, accountId: i.accountId, payee: i.name, total: i.amount }),
    line_tail: i.entry === 'handover' ? null : hash32(`${i.name}|${i.amount}`),
    note: i.note?.trim() || null,
  };
}
