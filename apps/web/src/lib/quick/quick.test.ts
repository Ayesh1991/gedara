import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: {} }));
import { buildSpend, localStamp } from './entry';
import { favourites, guard, hourGap, learnedAmount, padPress, rankTiles, type Use } from './rank';
import { EMPTY_STATE, cashCheckDue, dropEntry, mergeSent, platform } from './merge';
import { StateSchema, type QuickState } from './schema';

const TZ = 'Asia/Colombo';
const hourOf = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(d));
const tile = (id: string, sort: number, extra: Partial<{ key: string | null; hidden: boolean; usual_amount: number | null }> = {}) => ({
  id, key: id, sort, hidden: false, usual_amount: null, ...extra,
});
/** n uses of a tile at a Colombo hour, one per day going back from `now`. */
const uses = (tileId: string, hour: number, n: number, now: Date, amount = 100): Use[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getTime() - (i + 1) * 86_400_000);
    d.setUTCHours(hour - 5, 30 - 30, 0, 0); // Colombo = UTC+5:30; close enough to land in that hour
    return { tile_id: tileId, amount, at: new Date(d.getTime() - 30 * 60_000 + 30 * 60_000).toISOString() };
  });

describe('tiles learn', () => {
  const tiles = [tile('tuk', 1), tile('bus', 2), tile('tea', 3), tile('other', 4), tile('hidden', 5, { hidden: true })];
  const morning = new Date('2026-11-12T02:30:00Z'); // 08:00 Colombo
  const evening = new Date('2026-11-12T13:30:00Z'); // 19:00 Colombo
  const history = [...uses('bus', 8, 6, morning), ...uses('tea', 19, 6, morning), ...uses('hidden', 8, 20, morning)];

  it('puts what is used at this time of day first, per time of day', () => {
    expect(rankTiles(tiles, history, morning, hourOf, 'learned').map((t) => t.id)).toEqual(['bus', 'tea', 'tuk', 'other']);
    expect(rankTiles(tiles, history, evening, hourOf, 'learned').map((t) => t.id)).toEqual(['tea', 'bus', 'tuk', 'other']);
  });
  it('keeps my own order when asked, hides hidden tiles, and Other is always last', () => {
    expect(rankTiles(tiles, history, morning, hourOf, 'mine').map((t) => t.id)).toEqual(['tuk', 'bus', 'tea', 'other']);
    const otherUsedMost = uses('other', 8, 30, morning);
    expect(rankTiles(tiles, otherUsedMost, morning, hourOf, 'learned').at(-1)!.id).toBe('other');
  });
  it('with no history the order is the starter order', () => {
    expect(rankTiles(tiles, [], morning, hourOf, 'learned').map((t) => t.id)).toEqual(['tuk', 'bus', 'tea', 'other']);
  });
  it('hours wrap around midnight', () => {
    expect(hourGap(23, 1)).toBe(2);
    expect(hourGap(8, 19)).toBe(11);
  });
});

describe('favourites and the usual amount', () => {
  const now = new Date('2026-11-12T02:30:00Z');
  it('learns an amount used on 3 of the last 5', () => {
    const u = [...uses('tea', 8, 3, now, 100), ...uses('tea', 9, 2, now, 150)];
    expect(learnedAmount('tea', u)).toBe(100);
    expect(learnedAmount('tea', uses('tea', 8, 2, now, 100))).toBeNull();
    expect(learnedAmount('bus', u)).toBeNull();
  });
  it('a hand-set amount wins; tiles without one are left out', () => {
    const ranked = [tile('tea', 1, { usual_amount: 120 }), tile('bus', 2), tile('tuk', 3)];
    const f = favourites(ranked, uses('bus', 8, 4, now, 60));
    expect(f.map((x) => [x.tile.id, x.amount])).toEqual([['tea', 120], ['bus', 60]]);
  });
});

describe('typo guard and the pad', () => {
  it('asks for a second tap on big or unusual amounts, stops at the hard limit', () => {
    expect(guard(350, null)).toBe('ok');
    expect(guard(5000, null)).toBe('ok');
    expect(guard(5001, null)).toBe('ask');
    expect(guard(35000, 300)).toBe('ask');
    expect(guard(1600, 300)).toBe('ask'); // more than 5× the usual and at least Rs 1,000
    expect(guard(350, 60)).toBe('ok'); // 5× a small usual is still small money
    expect(guard(200000, null)).toBe('ask');
    expect(guard(200001, null)).toBe('stop');
    expect(guard(0, null)).toBe('stop');
  });
  it('types whole rupees, up to 6 digits, no leading zeros', () => {
    let s = '';
    for (const k of ['0', '00', '3', '5', '0'] as const) s = padPress(s, k);
    expect(s).toBe('350');
    expect(padPress('350', 'back')).toBe('35');
    expect(padPress('350', 'clear')).toBe('');
    expect(padPress('123456', '7')).toBe('123456');
    expect(padPress('12345', '00')).toBe('12345');
  });
});

describe('an entry is fixed at the tap', () => {
  const input = {
    householdId: 'h', userId: 'u', timeZone: TZ, entry: 'expense' as const, tileId: 't1', name: 'Tea', categoryId: 'c', amount: 100,
    accountId: 'wallet', now: new Date('2026-11-12T18:45:10Z'), opId: '00000000-0000-0000-0000-000000000001',
  };
  it('uses the household date and time (after midnight in Colombo is the next day)', () => {
    expect(localStamp(TZ, input.now)).toEqual({ date: '2026-11-13', time: '00:15:10' });
  });
  it('the same tap always gives the same fingerprints (rule 5), a different tap a different one', () => {
    const a = buildSpend(input);
    const b = buildSpend(input);
    expect(a.fingerprint).toMatch(/^m[0-9a-z]{1,13}$/);
    expect(a.line_tail).toMatch(/^[0-9a-z]{1,13}$/);
    expect([b.fingerprint, b.line_tail, b.client_at]).toEqual([a.fingerprint, a.line_tail, a.client_at]);
    expect(buildSpend({ ...input, now: new Date('2026-11-12T18:45:11Z') }).fingerprint).not.toBe(a.fingerprint);
    expect(buildSpend({ ...input, amount: 110 }).fingerprint).not.toBe(a.fingerprint);
  });
  it('pays from the wallet unless another account was chosen; holds only amount, tile and time', () => {
    const a = buildSpend(input);
    expect(a.account_id).toBeNull();
    expect(buildSpend({ ...input, accountId: 'boc', explicitAccount: true }).account_id).toBe('boc');
    expect(Object.keys(a).sort()).toEqual([
      'account_id', 'amount', 'category_id', 'client_at', 'entry', 'fingerprint', 'household_id', 'immediate', 'kind', 'label',
      'line_tail', 'name', 'note', 'op_id', 'state', 'tile_id', 'to_account_id', 'user_id',
    ]);
  });
  it('a hand-over is a transfer to the other wallet with no line', () => {
    const g = buildSpend({ ...input, entry: 'handover', toAccountId: 'hers' });
    expect([g.to_account_id, g.line_tail, g.category_id]).toEqual(['hers', null, null]);
  });
});

describe('what the screen shows after sending', () => {
  const base: QuickState = {
    ...EMPTY_STATE, balance: 1000,
    prefs: { cash_account_id: 'wallet', order_mode: 'learned', hand: 'right', cash_check: true, cash_checked_on: null },
  };
  const op = buildSpend({
    householdId: 'h', userId: 'u', timeZone: TZ, entry: 'expense', tileId: 't', name: 'Tea', categoryId: 'c', amount: 100, accountId: 'wallet',
    now: new Date('2026-11-12T04:00:00Z'),
  });
  it('adds the entry once and takes it off the wallet', () => {
    const one = mergeSent(base, op, 'tx1', TZ);
    expect([one.entries.length, one.balance, one.since_check]).toEqual([1, 900, 1]);
    expect(mergeSent(one, op, 'tx1', TZ)).toBe(one);
    expect(one.entries[0]).toMatchObject({ id: 'tx1', occurred_on: '2026-11-12', occurred_at: '09:30:00', label: 'Tea' });
  });
  it('another account leaves the wallet alone; undo puts the money back', () => {
    const other = mergeSent(base, { ...op, account_id: 'boc' }, 'tx2', TZ);
    expect(other.balance).toBe(1000);
    const back = dropEntry(mergeSent(base, op, 'tx1', TZ), op.op_id);
    expect([back.balance, back.since_check, back.entries[0]!.id]).toEqual([1000, 0, null]);
  });
  it('reads the database answer (numbers may arrive as text)', () => {
    const parsed = StateSchema.parse({
      prefs: null, balance: '4530.00', tiles: [], accounts: [], wallets: [], since_check: 4,
      entries: [{ op_id: 'a', tile_id: null, kind: 'expense', client_at: '2026-11-12T03:00:00Z', id: null, amount: '100.00',
        account_id: null, occurred_on: null, occurred_at: null, notes: null, label: null, category_id: null }],
    });
    expect([parsed.balance, parsed.entries[0]!.amount]).toEqual([4530, 100]);
  });
});

describe('the cash check is gentle', () => {
  const s = (over: Partial<QuickState['prefs'] & object>, since: number, balance: number | null = 3200) => ({
    prefs: { cash_account_id: 'w', order_mode: 'learned' as const, hand: 'right' as const, cash_check: true, cash_checked_on: null, ...over },
    balance, since_check: since,
  });
  it('asks only after 5 entries, at most weekly, and never when switched off', () => {
    expect(cashCheckDue(s({}, 4), '2026-11-12')).toBe(false);
    expect(cashCheckDue(s({}, 5), '2026-11-12')).toBe(true);
    expect(cashCheckDue(s({ cash_checked_on: '2026-11-06' }, 9), '2026-11-12')).toBe(false);
    expect(cashCheckDue(s({ cash_checked_on: '2026-11-05' }, 9), '2026-11-12')).toBe(true);
    expect(cashCheckDue(s({ cash_check: false }, 9), '2026-11-12')).toBe(false);
    expect(cashCheckDue(s({}, 9, null), '2026-11-12')).toBe(false);
  });
});

describe('install help knows the device', () => {
  it('tells iPhone, iPad (which says Macintosh) and Android apart', () => {
    expect(platform('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', 5)).toBe('ios');
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(platform('Mozilla/5.0 (Linux; Android 16; Pixel 9)', 5)).toBe('android');
  });
});

describe('a scanned bill for something already entered in Quick spend', () => {
  it('pairs a bill with the quick entry of the same total within a day, once each', async () => {
    const { matchTwins } = await import('./twins');
    const entries = [
      { transaction_id: 'q1', total: 850, occurred_on: '2026-11-11', name: 'Meal' },
      { transaction_id: 'q2', total: 850, occurred_on: '2026-11-12', name: 'Meal' },
      { transaction_id: 'q3', total: 100, occurred_on: '2026-11-12', name: 'Tea' },
    ];
    const twins = matchTwins(
      [
        { id: 'b1', total: 850, occurred_on: '2026-11-12' },
        { id: 'b2', total: 850.0, occurred_on: '2026-11-12' },
        { id: 'b3', total: 100, occurred_on: '2026-11-15' },
        { id: 'b4', total: 99, occurred_on: '2026-11-12' },
      ],
      entries,
    );
    expect(twins.map((t) => [t.bill.id, t.entry.transaction_id])).toEqual([['b1', 'q2'], ['b2', 'q1']]);
  });
});
