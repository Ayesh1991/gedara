import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/db.types';
import { CheckError, buildChecks, runCheck, withTimeout } from './checks';

type StatusCb = (status: string, err?: Error) => void;

/** Fake client whose removeChannel re-enters the subscribe callback with CLOSED, like realtime-js. */
function fakeRealtime(first: 'SUBSCRIBED' | 'CHANNEL_ERROR') {
  let cb: StatusCb = () => undefined;
  const channel = {
    subscribe: (fn: StatusCb) => {
      cb = fn;
      queueMicrotask(() => cb(first, first === 'CHANNEL_ERROR' ? new Error('denied') : undefined));
      return channel;
    },
  };
  const removeChannel = vi.fn(() => {
    cb('CLOSED');
    return Promise.resolve('ok');
  });
  const supabase = { channel: () => channel, removeChannel } as unknown as SupabaseClient<Database>;
  return { supabase, removeChannel };
}

describe('realtime check', () => {
  it('passes on SUBSCRIBED even though removing the channel reports CLOSED', async () => {
    const { supabase, removeChannel } = fakeRealtime('SUBSCRIBED');
    const checks = buildChecks({ supabase, appVersion: '1', getSwVersion: () => Promise.resolve('1') });
    await expect(checks.realtime()).resolves.toBe('SUBSCRIBED');
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('fails on CHANNEL_ERROR and removes the channel once', async () => {
    const { supabase, removeChannel } = fakeRealtime('CHANNEL_ERROR');
    const checks = buildChecks({ supabase, appVersion: '1', getSwVersion: () => Promise.resolve('1') });
    await expect(checks.realtime()).rejects.toThrow('denied');
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

describe('withTimeout', () => {
  it('resolves when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it('rejects when the timer wins', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow('timeout 10');
  });
});

describe('runCheck', () => {
  it('reports success with the detail', async () => {
    const r = await runCheck('db', () => Promise.resolve('schema 5'), { timeoutMs: 50, t });
    expect(r).toMatchObject({ id: 'db', ok: true, detail: 'schema 5' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('maps a timeout to the i18n message', async () => {
    const r = await runCheck('realtime', () => new Promise(() => undefined), { timeoutMs: 10, t });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('diagnostics.errors.timeout {"ms":10}');
  });

  it('maps a CheckError to its i18n key', async () => {
    const r = await runCheck(
      'sw',
      () => Promise.reject(new CheckError('diagnostics.errors.swMismatch', { sw: '0.0.1', app: '0.0.2' })),
      { timeoutMs: 50, t },
    );
    expect(r.error).toBe('diagnostics.errors.swMismatch {"sw":"0.0.1","app":"0.0.2"}');
  });

  it('never throws on unexpected errors', async () => {
    const r = await runCheck('edge', () => Promise.reject(new Error('boom')), { timeoutMs: 50, t });
    expect(r).toMatchObject({ ok: false, error: 'boom' });
  });
});
