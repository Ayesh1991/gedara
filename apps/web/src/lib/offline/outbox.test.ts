import { describe, expect, it } from 'vitest';
import { classifyError, createOutbox, newOpBase, type QueuedOp, type SendResult, type SpendOp, type StockOp } from './outbox';

function memoryStorage() {
  let ops: QueuedOp[] = [];
  return {
    load: async () => ops,
    update: async (fn: (o: QueuedOp[]) => QueuedOp[]) => (ops = fn(ops)),
  };
}

function stockOp(label: string): StockOp {
  return { ...newOpBase('h1', label), kind: 'stock', action: 'consume', payload: { household_id: 'h1', qty: 1 } };
}

function setup(script: (op: QueuedOp) => SendResult) {
  const state = { online: true, sent: [] as string[] };
  const box = createOutbox({
    storage: memoryStorage(),
    online: () => state.online,
    send: async (op) => {
      state.sent.push(op.label);
      return script(op);
    },
  });
  return { box, state };
}

const ok: SendResult = { type: 'ok', result: { correlation_id: 'c1' } };
const refused: SendResult = { type: 'refused', error: { code: 'GDSTK', message: 'not enough stock', available: 0 } };
const down: SendResult = { type: 'transient', message: 'Failed to fetch' };

describe('outbox', () => {
  it('sends at once when online and reports the result', async () => {
    const { box } = setup(() => ok);
    expect(await box.submit(stockOp('a'))).toEqual({ status: 'done', result: { correlation_id: 'c1' } });
    expect(box.list()).toEqual([]);
  });

  it('queues offline and replays in the order tapped', async () => {
    const { box, state } = setup(() => ok);
    state.online = false;
    expect((await box.submit(stockOp('a'))).status).toBe('queued');
    expect((await box.submit(stockOp('b'))).status).toBe('queued');
    expect(state.sent).toEqual([]);
    state.online = true;
    const report = await box.flush();
    expect(state.sent).toEqual(['a', 'b']);
    expect(report.sent.map((o) => o.label)).toEqual(['a', 'b']);
    expect(box.list()).toEqual([]);
  });

  it('keeps the same op id across retries (the database de-duplicates)', async () => {
    const ids: string[] = [];
    let fail = true;
    const { box } = setup((op) => {
      ids.push(op.op_id);
      if (fail) {
        fail = false;
        return down;
      }
      return ok;
    });
    expect((await box.submit(stockOp('a'))).status).toBe('queued');
    await box.flush();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('stops at the first network failure so later ops never overtake', async () => {
    const { box, state } = setup((op) => (op.label === 'a' ? down : ok));
    state.online = false;
    await box.submit(stockOp('a'));
    await box.submit(stockOp('b'));
    state.online = true;
    const report = await box.flush();
    expect(state.sent).toEqual(['a']);
    expect(report.stoppedBy).toBe('Failed to fetch');
    expect(box.list().map((o) => o.label)).toEqual(['a', 'b']);
  });

  it('a refusal while the person watches is shown and dropped, not parked', async () => {
    const { box } = setup(() => refused);
    const out = await box.submit(stockOp('a'));
    expect(out).toEqual({ status: 'refused', error: refused.type === 'refused' ? refused.error : null });
    expect(box.list()).toEqual([]);
  });

  it('a refusal on replay parks the op and carries on with the rest', async () => {
    const { box, state } = setup((op) => (op.label === 'a' ? refused : ok));
    state.online = false;
    await box.submit(stockOp('a'));
    await box.submit(stockOp('b'));
    state.online = true;
    const report = await box.flush();
    expect(report.parked.map((o) => o.label)).toEqual(['a']);
    expect(report.sent.map((o) => o.label)).toEqual(['b']);
    expect(box.list()).toMatchObject([{ label: 'a', state: 'parked', error: { code: 'GDSTK' } }]);
    // Parked ops are not sent again by later flushes.
    await box.flush();
    expect(state.sent).toEqual(['a', 'b']);
  });

  it('an op held back by the network is parked (not dropped) if refused later', async () => {
    let calls = 0;
    const { box } = setup(() => (++calls === 1 ? down : refused));
    expect((await box.submit(stockOp('a'))).status).toBe('queued');
    await box.flush();
    expect(box.list()).toMatchObject([{ label: 'a', state: 'parked' }]);
  });

  it('an op tapped "online" behind a stuck op is parked, not dropped, when refused later', async () => {
    let net = false;
    const { box, state } = setup((op) => (!net ? down : op.label === 'b' ? refused : ok));
    state.online = false;
    await box.submit(stockOp('a'));
    state.online = true; // the phone claims to be online, but requests still fail
    expect((await box.submit(stockOp('b'))).status).toBe('queued');
    net = true;
    await box.flush();
    expect(box.list()).toMatchObject([{ label: 'b', state: 'parked' }]);
  });

  it('remove takes an op out before it syncs (Undo / Discard)', async () => {
    const { box, state } = setup(() => ok);
    state.online = false;
    const op = stockOp('a');
    await box.submit(op);
    expect(await box.remove(op.op_id)).toBe(true);
    expect(await box.remove(op.op_id)).toBe(false);
    state.online = true;
    await box.flush();
    expect(state.sent).toEqual([]);
  });

  it('concurrent flushes run one after the other and send each op once', async () => {
    const { box, state } = setup(() => ok);
    state.online = false;
    await box.submit(stockOp('a'));
    await box.submit(stockOp('b'));
    state.online = true;
    await Promise.all([box.flush(), box.flush(), box.flush()]);
    expect(state.sent).toEqual(['a', 'b']);
  });
});

describe('classifyError', () => {
  it('SQLSTATE codes are refusals, with the available quantity for GDSTK', () => {
    expect(classifyError({ code: 'GDSTK', message: 'not enough stock', details: '2.5' })).toEqual({
      type: 'refused',
      error: { code: 'GDSTK', message: 'not enough stock', available: 2.5 },
    });
    expect(classifyError({ code: '42501', message: 'not allowed' }).type).toBe('refused');
  });
  it('network, PostgREST and auth problems are transient', () => {
    expect(classifyError({ code: '', message: 'TypeError: Failed to fetch' }).type).toBe('transient');
    expect(classifyError({ code: 'PGRST301', message: 'JWT expired' }).type).toBe('transient');
    expect(classifyError(new Error('aborted')).type).toBe('transient');
  });
});

describe('move ops (Phase 7b)', () => {
  it('queue offline like stock ops and replay in order', async () => {
    const { box, state } = setup(() => ok);
    state.online = false;
    const move = { ...newOpBase('h1', 'Drill → Box 3'), kind: 'move' as const, item: 'asset' as const, item_id: 'a1', to: 'l3' };
    expect((await box.submit(move)).status).toBe('queued');
    expect((await box.submit(stockOp('b'))).status).toBe('queued');
    state.online = true;
    await box.flush();
    expect(state.sent).toEqual(['Drill → Box 3', 'b']);
  });

  it('a queued move refused because the item moved again is parked with the reason', async () => {
    const newer: SendResult = { type: 'refused', error: { code: 'GDMVC', message: 'moved again', available: null, detail: 'newer' } };
    const { box, state } = setup(() => newer);
    state.online = false;
    await box.submit({ ...newOpBase('h1', 'Drill → Box 3'), kind: 'move', item: 'asset', item_id: 'a1', to: 'l3' });
    state.online = true;
    const report = await box.flush();
    expect(report.parked).toHaveLength(1);
    expect(box.list()[0]).toMatchObject({ state: 'parked', error: { code: 'GDMVC', detail: 'newer' } });
  });
});

describe('classifyError details', () => {
  it('keeps a text detail (GDMVC newer / moved) but not the GDSTK number', () => {
    expect(classifyError({ code: 'GDMVC', message: 'x', details: 'moved' })).toEqual({
      type: 'refused',
      error: { code: 'GDMVC', message: 'x', available: null, detail: 'moved' },
    });
    expect(classifyError({ code: 'GDSTK', message: 'x', details: '3' })).toEqual({
      type: 'refused',
      error: { code: 'GDSTK', message: 'x', available: 3 },
    });
  });
});

// ── Quick spend entries (Phase 12) ────────────────────────────────────────────────────────────────
// A pretend database that remembers the op ids it has taken, like rpc_quick_spend: the same id
// again is a replay and counts nothing.
describe('Quick spend entries (Phase 12)', () => {
  function spend(name: string, amount: number, user = 'u1'): SpendOp {
    return {
      ...newOpBase('h1', `${name} ${amount}`), kind: 'spend', user_id: user, entry: 'expense', tile_id: null, name,
      category_id: null, amount, account_id: null, fingerprint: 'm1', line_tail: 'x',
    };
  }
  function world(shared = memoryStorage()) {
    const db = { taken: new Map<string, number>(), order: [] as string[], requests: 0, user: 'u1' as string | null, down: false, refuse: new Set<string>() };
    const state = { online: true };
    const sendSpends = async (ops: SpendOp[]): Promise<SendResult[]> => {
      if (db.user !== ops[0]!.user_id) return ops.map(() => ({ type: 'hold', reason: db.user ? 'other-user' : 'signed-out' }));
      db.requests++;
      if (db.down) return ops.map(() => down);
      return ops.map((o) => {
        if (db.refuse.has(o.name)) return { type: 'refused', error: { code: 'GDQAM', message: 'amount out of range', available: null } };
        if (db.taken.has(o.op_id)) return { type: 'ok', result: { id: 'tx', replayed: true } };
        db.taken.set(o.op_id, o.amount);
        db.order.push(o.name);
        return { type: 'ok', result: { id: 'tx', replayed: false } };
      });
    };
    const box = createOutbox({
      storage: shared,
      online: () => state.online,
      send: async (op) => (op.kind === 'spend' ? (await sendSpends([op]))[0]! : ok),
      sendSpends,
    });
    const total = () => [...db.taken.values()].reduce((s, a) => s + a, 0);
    return { box, db, state, total, shared };
  }

  it('entries made with no signal are sent later in the order tapped, in one request', async () => {
    const { box, db, state, total } = world();
    state.online = false;
    for (const [n, a] of [['Bus', 60], ['Tea', 100], ['Tuk', 350]] as const) expect((await box.submit(spend(n, a))).status).toBe('queued');
    expect(db.requests).toBe(0);
    state.online = true;
    const report = await box.flush();
    expect(db.order).toEqual(['Bus', 'Tea', 'Tuk']);
    expect([db.requests, report.sent.length, total(), box.list().length]).toEqual([1, 3, 510, 0]);
  });

  it('double-send: an answer lost on the way is sent again and counted once', async () => {
    const { box, db, total } = world();
    const op = spend('Tea', 100);
    // The database took it, but the phone never heard back (timeout): it stays queued.
    db.taken.set(op.op_id, op.amount);
    db.down = true;
    expect((await box.submit(op)).status).toBe('queued');
    db.down = false;
    await box.flush();
    await box.flush();
    expect([total(), db.taken.size, box.list().length]).toEqual([100, 1, 0]);
    expect(box.resultOf(op.op_id)).toMatchObject({ replayed: true });
  });

  it('out of order: entries reaching the database in another order are each counted once', async () => {
    const a = world();
    const ops = [spend('Bus', 60), spend('Tea', 100), spend('Tuk', 350)];
    // "The other tab" got the last one through first.
    a.db.taken.set(ops[2]!.op_id, 350);
    a.state.online = false;
    for (const o of ops) await a.box.submit(o);
    a.state.online = true;
    await a.box.flush();
    expect([a.total(), a.db.taken.size]).toEqual([510, 3]);
  });

  it('two tabs / two phones sharing the queue send each entry once', async () => {
    const one = world();
    const two = world(one.shared);
    two.db = one.db; // same database
    const box2 = createOutbox({
      storage: one.shared, online: () => true, send: async () => ok,
      sendSpends: async (ops) => ops.map((o) => {
        const replayed = one.db.taken.has(o.op_id);
        one.db.taken.set(o.op_id, o.amount);
        return { type: 'ok', result: { id: 'tx', replayed } };
      }),
    });
    one.state.online = false;
    await one.box.submit(spend('Bus', 60));
    await one.box.submit(spend('Tea', 100));
    one.state.online = true;
    await box2.init();
    await Promise.all([one.box.flush(), box2.flush(), one.box.flush()]);
    expect([one.total(), one.db.taken.size]).toEqual([160, 2]);
    expect((await one.shared.load()).length).toBe(0);
  });

  it('never dropped: a refusal parks the entry even when it was sent at once, and the rest go on', async () => {
    const { box, db } = world();
    db.refuse.add('Typo');
    expect((await box.submit(spend('Typo', 999999))).status).toBe('queued');
    expect(box.list().map((o) => [o.label, o.state])).toEqual([['Typo 999999', 'parked']]);
    expect((await box.submit(spend('Tea', 100))).status).toBe('done');
    expect(box.list().length).toBe(1);
  });

  it('login expired: nothing is sent, nothing is lost, and it goes through after signing in', async () => {
    const { box, db, total } = world();
    db.user = null;
    expect((await box.submit(spend('Tea', 100))).status).toBe('queued');
    const report = await box.flush();
    expect([db.requests, report.held.length, report.stoppedBy, box.list().length]).toEqual([0, 1, null, 1]);
    db.user = 'u1';
    await box.flush();
    expect([total(), box.list().length]).toEqual([100, 0]);
  });

  it("another person's waiting entries are held and do not block mine or the pantry's", async () => {
    const { box, db, total } = world();
    db.user = 'u2';
    await box.submit(spend('Hers', 500, 'u1')); // made by u1, who is no longer signed in
    await box.submit(stockOp('Milk −1'));
    await box.submit(spend('Mine', 60, 'u2'));
    expect(db.order).toEqual(['Mine']);
    expect([total(), box.list().map((o) => o.label)]).toEqual([60, ['Hers 500']]);
  });

  it('a network failure leaves every entry waiting, in order', async () => {
    const { box, db } = world();
    db.down = true;
    await box.submit(spend('Bus', 60));
    await box.submit(spend('Tea', 100));
    const report = await box.flush();
    expect([report.stoppedBy, box.list().map((o) => o.state)]).toEqual(['Failed to fetch', ['queued', 'queued']]);
    db.down = false;
    await box.flush();
    expect(db.order).toEqual(['Bus', 'Tea']);
  });

  it('Undo before it was sent takes it out of the queue', async () => {
    const { box, db, state, total } = world();
    state.online = false;
    const op = spend('Tea', 100);
    await box.submit(op);
    expect(await box.remove(op.op_id)).toBe(true);
    state.online = true;
    await box.flush();
    expect([total(), db.requests]).toEqual([0, 0]);
  });
});
