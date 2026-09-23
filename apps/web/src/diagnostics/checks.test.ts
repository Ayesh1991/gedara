import { describe, expect, it } from 'vitest';
import { CheckError, runCheck, withTimeout } from './checks';

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
