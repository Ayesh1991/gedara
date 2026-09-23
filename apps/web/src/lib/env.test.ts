import { describe, expect, it, vi } from 'vitest';

// env.ts parses import.meta.env on import; give it a valid one.
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'x'.repeat(40));

const { parseEnv } = await import('./env');

describe('parseEnv', () => {
  it('accepts a valid config and applies defaults', () => {
    const env = parseEnv({
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'x'.repeat(40),
    });
    expect(env.VITE_APP_ENV).toBe('local');
    expect(env.VITE_PUBLIC_BASE_URL).toBe('https://gedara.vercel.app');
  });

  it('names the missing fields without echoing values', () => {
    expect(() => parseEnv({ VITE_SUPABASE_URL: 'not a url' })).toThrow(
      'Invalid environment configuration: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY',
    );
  });

  it('rejects unknown environments', () => {
    expect(() =>
      parseEnv({
        VITE_SUPABASE_URL: 'https://abc.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'x'.repeat(40),
        VITE_APP_ENV: 'production',
      }),
    ).toThrow('VITE_APP_ENV');
  });
});
