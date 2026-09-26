import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';

// Rule 12: every UI string goes through i18n. This catches keys used in code but missing from en.json
// (dynamic keys like `nav.${key}` are checked by the typed t() at compile time instead).
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

function lookup(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('i18n', () => {
  const srcDir = path.resolve(import.meta.dirname, '..');
  const used = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
  }

  it('finds translation calls in the source', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it.each([...used])('en.json has "%s"', (key) => {
    expect(typeof lookup(en, key)).toBe('string');
  });
});

describe('Sinhala (si.json)', () => {
  function flat(obj: unknown, prefix = ''): Record<string, string> {
    return Object.entries(obj as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return typeof v === 'string' ? { ...acc, [key]: v } : { ...acc, ...flat(v, key) };
    }, {});
  }
  const enFlat = flat(en);
  const siFlat = flat(JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'si.json'), 'utf8')));
  const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

  it('translates every English string (nothing falls back to English)', () => {
    expect(Object.keys(enFlat).filter((k) => !(k in siFlat))).toEqual([]);
  });

  it('has no keys English does not have', () => {
    expect(Object.keys(siFlat).filter((k) => !(k in enFlat))).toEqual([]);
  });

  it('keeps every {{placeholder}}', () => {
    const wrong = Object.keys(siFlat).filter((k) => k in enFlat && placeholders(siFlat[k]!).join() !== placeholders(enFlat[k]!).join());
    expect(wrong).toEqual([]);
  });
});
