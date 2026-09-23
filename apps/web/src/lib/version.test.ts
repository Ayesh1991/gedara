import { describe, expect, it } from 'vitest';
import { formatBadge } from './version';

describe('formatBadge', () => {
  it('joins version, sha, schema and env', () => {
    expect(formatBadge({ version: '0.0.1', sha: 'a1b2c3d', schemaVersion: 5, env: 'staging' })).toBe(
      'v0.0.1 · a1b2c3d · db 5 · staging',
    );
  });

  it('shows "db ?" until the schema version is known', () => {
    expect(formatBadge({ version: '0.0.1', sha: 'a1b2c3d', schemaVersion: undefined, env: 'prod' })).toBe(
      'v0.0.1 · a1b2c3d · db ? · prod',
    );
  });
});
