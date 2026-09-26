import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countUpValue, easeOutCubic } from '@/lib/countUp';
import { DEFAULT_PREFS, MOTION_MODES, PREFS_STORAGE_KEY, parsePrefs, reconcile, resolveMotion } from './prefs';
import { DEFAULT_THEME, THEME_IDS, THEMES } from './themes';

const HEX = /^#[0-9a-f]{6}$/;
const css = readFileSync(path.resolve(import.meta.dirname, '../styles/index.css'), 'utf8');

/** The custom properties declared in one CSS block (`:root {` or `:root[data-theme='x'] {`). */
function cssVars(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing CSS block ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
}

describe('theme registry', () => {
  it.each(THEME_IDS)('%s has valid colours', (id) => {
    const t = THEMES[id];
    expect(t.id).toBe(id);
    for (const c of [...t.aur, t.accentA, t.accentB, t.glow]) expect(c).toMatch(HEX);
  });

  it.each(THEME_IDS)('%s matches the CSS the app paints', (id) => {
    const vars = cssVars(id === DEFAULT_THEME ? ':root' : `:root[data-theme='${id}']`);
    const t = THEMES[id];
    expect([vars['--aur-1'], vars['--aur-2'], vars['--aur-3']]).toEqual([...t.aur]);
    expect(vars['--accent-a']).toBe(t.accentA);
    expect(vars['--accent-b']).toBe(t.accentB);
    expect(vars['--glow']).toBe(t.glow);
  });

  it('gold and status colours are not themeable', () => {
    for (const id of THEME_IDS.filter((i) => i !== DEFAULT_THEME)) {
      const vars = cssVars(`:root[data-theme='${id}']`);
      for (const fixed of ['--gold', '--red', '--caution', '--due', '--info', '--teal', '--ink']) {
        expect(vars[fixed], `${id} overrides ${fixed}`).toBeUndefined();
      }
    }
  });
});

describe('pre-paint script in index.html', () => {
  const html = readFileSync(path.resolve(import.meta.dirname, '../../index.html'), 'utf8');

  it('knows every theme and motion mode, and the same storage key', () => {
    expect(html).toContain(`[${THEME_IDS.map((i) => `'${i}'`).join(', ')}]`);
    expect(html).toContain(`[${MOTION_MODES.map((m) => `'${m}'`).join(', ')}]`);
    expect(html).toContain(`localStorage.getItem('${PREFS_STORAGE_KEY}')`);
  });
});

describe('prefs', () => {
  it('parses valid prefs', () => {
    expect(parsePrefs({ theme: 'nebula', motion: 'off', swipe: true, lang: 'si', updatedAt: 5 })).toEqual({ theme: 'nebula', motion: 'off', swipe: true, lang: 'si', updatedAt: 5 });
  });

  it('falls back field by field on unknown values', () => {
    expect(parsePrefs({ theme: 'hotpink', motion: 'off' })).toEqual({ theme: 'aurora', motion: 'off', swipe: false, lang: 'en', updatedAt: 0 });
    expect(parsePrefs({ theme: 'lagoon', motion: 42, updatedAt: -1 })).toEqual({ theme: 'lagoon', motion: 'system', swipe: false, lang: 'en', updatedAt: 0 });
  });

  it('falls back entirely on garbage', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('nebula')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({})).toEqual(DEFAULT_PREFS);
  });

  it('reconciles devices: newer wins, an interrupted save is pushed again', () => {
    const at = (theme: 'aurora' | 'nebula', updatedAt: number) => ({ theme, motion: 'system' as const, swipe: false, lang: 'en' as const, updatedAt });
    // another device changed it later → adopt
    expect(reconcile(at('aurora', 10), at('nebula', 20))).toEqual({ adopt: at('nebula', 20), push: false });
    // this device changed it later (save lost to a reload) → push ours
    expect(reconcile(at('nebula', 30), at('aurora', 20))).toEqual({ adopt: null, push: true });
    // account has nothing yet: push only if the user ever chose something here
    expect(reconcile(at('nebula', 30), null)).toEqual({ adopt: null, push: true });
    expect(reconcile(DEFAULT_PREFS, null)).toEqual({ adopt: null, push: false });
    // in sync → nothing
    expect(reconcile(at('nebula', 30), at('nebula', 30))).toEqual({ adopt: null, push: false });
  });

  it('resolves motion: explicit wins, system follows the OS', () => {
    expect(resolveMotion('on', true)).toBe(true);
    expect(resolveMotion('off', false)).toBe(false);
    expect(resolveMotion('system', true)).toBe(false);
    expect(resolveMotion('system', false)).toBe(true);
  });
});

describe('count-up', () => {
  it('eases from 0 to target and clamps', () => {
    expect(countUpValue(1000, 0, 1400)).toBe(0);
    expect(countUpValue(1000, 700, 1400)).toBeCloseTo(875);
    expect(countUpValue(1000, 5000, 1400)).toBe(1000);
    expect(easeOutCubic(-1)).toBe(0);
  });

  it('jumps straight to the target with no duration', () => {
    expect(countUpValue(84250, 0, 0)).toBe(84250);
  });
});
