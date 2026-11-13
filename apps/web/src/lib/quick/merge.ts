// Quick spend (Phase 12): keeping what the screen shows right after an entry was sent or undone,
// without asking the database again (one request per entry). Pure.
import type { SpendOp } from '../offline/outbox';
import { localStamp } from './entry';
import type { Entry, QuickState } from './schema';

export const EMPTY_STATE: QuickState = {
  prefs: null, balance: null, tiles: [], accounts: [], wallets: [], entries: [], since_check: 0,
};

/** An entry the database has taken, added to what the screen shows without another request. */
export function mergeSent(state: QuickState, op: SpendOp, txId: string | null, timeZone: string): QuickState {
  if (state.entries.some((e) => e.op_id === op.op_id)) return state;
  const { date, time } = localStamp(timeZone, new Date(op.client_at));
  const wallet = state.prefs?.cash_account_id ?? null;
  const account = op.account_id ?? wallet;
  const entry: Entry = {
    op_id: op.op_id, tile_id: op.tile_id, kind: op.entry, client_at: op.client_at, id: txId, amount: op.amount,
    account_id: account, occurred_on: date, occurred_at: time, notes: op.note ?? null, label: op.name, category_id: op.category_id,
  };
  const fromWallet = txId !== null && account === wallet;
  return {
    ...state,
    entries: [entry, ...state.entries],
    balance: fromWallet && state.balance !== null ? Math.round((state.balance - op.amount) * 100) / 100 : state.balance,
    since_check: fromWallet ? state.since_check + 1 : state.since_check,
  };
}

/** A deleted entry taken out again (Undo, Delete). */
export function dropEntry(state: QuickState, opId: string): QuickState {
  const e = state.entries.find((x) => x.op_id === opId);
  if (!e || e.id === null) return state;
  const fromWallet = e.account_id === (state.prefs?.cash_account_id ?? null);
  return {
    ...state,
    entries: state.entries.map((x) => (x.op_id === opId ? { ...x, id: null } : x)),
    balance: fromWallet && state.balance !== null ? Math.round((state.balance + e.amount) * 100) / 100 : state.balance,
    since_check: fromWallet ? Math.max(0, state.since_check - 1) : state.since_check,
  };
}

/** Is it time for the gentle cash check? At most weekly, only after five or more cash entries. */
export const CHECK_EVERY_DAYS = 7;
export const CHECK_AFTER_ENTRIES = 5;
export function cashCheckDue(state: Pick<QuickState, 'prefs' | 'balance' | 'since_check'>, today: string): boolean {
  const p = state.prefs;
  if (!p || !p.cash_check || !p.cash_account_id || state.balance === null) return false;
  if (state.since_check < CHECK_AFTER_ENTRIES) return false;
  if (!p.cash_checked_on) return true;
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.cash_checked_on}T00:00:00Z`)) / 86_400_000;
  return days >= CHECK_EVERY_DAYS;
}

/** Which install steps to show. An iPad says "Macintosh" but has a touch screen. */
export function platform(ua: string, touchPoints: number): 'ios' | 'android' | 'other' {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
