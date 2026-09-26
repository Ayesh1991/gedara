import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXCLUDED_TABLES, EXPORT_TABLES, csvRow, zipPath } from './tables';

// Tables of the public schema as the generated types list them.
function dbTables(): string[] {
  const src = readFileSync(new URL('../db.types.ts', import.meta.url), 'utf8');
  const pub = src.slice(src.indexOf('public: {'));
  const block = pub.slice(pub.indexOf('Tables: {'), pub.indexOf('Views: {'));
  return [...block.matchAll(/^ {6}(\w+): \{\n {8}Row/gm)].map((m) => m[1]!);
}

describe('export', () => {
  it('covers every table except the secrets and build metadata', () => {
    const exported = new Set(EXPORT_TABLES.map((t) => t.name));
    const missing = dbTables().filter((t) => !exported.has(t) && !EXCLUDED_TABLES.includes(t));
    expect(missing).toEqual([]);
    for (const secret of ['sms_device', 'push_subscription']) expect(exported.has(secret)).toBe(false);
  });

  it('writes JSON columns as text in CSV', () => {
    expect(csvRow({ a: 1, b: null, c: { x: [1] }, d: 'hi', e: true })).toEqual({ a: 1, b: null, c: '{"x":[1]}', d: 'hi', e: true });
  });

  it('keeps stored files inside the zip folder', () => {
    expect(zipPath('hh/asset/1/a.webp')).toBe('files/hh/asset/1/a.webp');
    expect(zipPath('/hh/a.webp')).toBe('files/hh/a.webp');
    expect(zipPath('hh/../../etc')).toBeNull();
    expect(zipPath('')).toBeNull();
  });
});
