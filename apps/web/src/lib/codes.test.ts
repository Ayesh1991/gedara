import { describe, expect, it } from 'vitest';
import { labelUrl, parseScan, shortLabelText, validGtin } from './codes';

describe('parseScan', () => {
  it('accepts raw codes in any case and whitespace', () => {
    expect(parseScan('HL:LOC:7K2P9Q')).toEqual({ kind: 'loc', code: 'HL:LOC:7K2P9Q' });
    expect(parseScan('  hl:loc:7k2p9q\n')).toEqual({ kind: 'loc', code: 'HL:LOC:7K2P9Q' });
    expect(parseScan('HL:PRD:3MX81A')).toEqual({ kind: 'prd', code: 'HL:PRD:3MX81A' });
  });

  it('normalises Crockford look-alikes', () => {
    expect(parseScan('HL:LOC:OIL234')).toEqual({ kind: 'loc', code: 'HL:LOC:011234' });
  });

  it('accepts ; for : (USB scanners on a non-US keyboard layout)', () => {
    expect(parseScan('HL;LOC;7K2P9Q')).toEqual({ kind: 'loc', code: 'HL:LOC:7K2P9Q' });
  });

  it('strips the /s/ URL form, from any host and URL-encoded', () => {
    expect(parseScan('https://gedara.vercel.app/s/HL:LOC:7K2P9Q')).toEqual({ kind: 'loc', code: 'HL:LOC:7K2P9Q' });
    expect(parseScan('https://old-host.example/s/HL%3ALOC%3A7K2P9Q?x=1')).toEqual({
      kind: 'loc',
      code: 'HL:LOC:7K2P9Q',
    });
  });

  it('rejects bad bodies and unknown prefixes', () => {
    expect(parseScan('HL:LOC:7K2P9').kind).toBe('unknown');
    expect(parseScan('HL:LOC:7K2P9U').kind).toBe('unknown');
    expect(parseScan('HL:XYZ:7K2P9Q').kind).toBe('unknown');
    expect(parseScan('').kind).toBe('unknown');
    expect(parseScan('hello world').kind).toBe('unknown');
  });

  it('recognises EAN/UPC with a valid check digit, and legacy Grocy codes', () => {
    expect(parseScan('4792024000222')).toEqual({ kind: 'ean', digits: '4792024000222' });
    expect(parseScan('4792024000223').kind).toBe('unknown');
    expect(parseScan('grcy:p:42')).toEqual({ kind: 'grocy', raw: 'grcy:p:42' });
  });
});

describe('helpers', () => {
  it('validates GTIN check digits', () => {
    expect(validGtin('96385074')).toBe(true);
    expect(validGtin('036000291452')).toBe(true);
    expect(validGtin('036000291453')).toBe(false);
  });

  it('builds label URLs', () => {
    expect(labelUrl('HL:LOC:7K2P9Q', 'https://gedara.vercel.app/')).toBe('https://gedara.vercel.app/s/HL:LOC:7K2P9Q');
  });

  it('makes a ≤10-char ASCII label line', () => {
    expect(shortLabelText('Box 3')).toBe('BOX 3');
    expect(shortLabelText('Kitchen pantry cupboard')).toBe('KITCHEN PA');
    expect(shortLabelText('Café')).toBe('CAFE');
  });
});
