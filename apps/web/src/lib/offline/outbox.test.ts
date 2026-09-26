import { describe, expect, it } from 'vitest';
import { classifyError, createOutbox, newOpBase, type QueuedOp, type SendResult, type StockOp } from './outbox';

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
