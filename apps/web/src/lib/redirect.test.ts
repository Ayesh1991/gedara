import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('safeRedirect', () => {
  it('keeps in-app paths', () => {
    expect(safeRedirect('/s/HL:LOC:7K2P9Q')).toBe('/s/HL:LOC:7K2P9Q');
    expect(safeRedirect('/places/labels?ids=a,b')).toBe('/places/labels?ids=a,b');
  });

  it('refuses anything that could leave the app or loop', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', undefined, 42, '/login?redirect=/x', '/a\nb']) {
      expect(safeRedirect(bad)).toBe('/');
    }
  });
});
