import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FORWARD_TEXT_REGEX, isSecret, normaliseForSecrets, secretReason } from '@sms/secret';
import { parseSms } from '@sms/parse';
import { REAL_ALERTS, SECRET_CORPUS, digits } from '@/lib/__fixtures__/secretCorpus';

// Phase 9 · hard rule 1: a one-time code must never be stored or sent to an AI. The same corpus is
// mirrored in supabase/tests/database/sms_secret.test.sql (the database's own check).

describe('secret detector (TypeScript)', () => {
  it.each(SECRET_CORPUS)('drops: %s', (text) => {
    expect(isSecret(text)).toBe(true);
  });

  it.each(REAL_ALERTS)('keeps the real %s alert', (_sender, body) => {
    expect(secretReason(body)).toBeNull();
  });

  it('every corpus text is dropped by the parser too, from every allow-listed sender', () => {
    for (const sender of ['BOC', 'SAMPCCTXN', 'PeoplesCard', 'Seylan Bank']) {
      for (const body of SECRET_CORPUS) {
        expect(parseSms({ sender, body, receivedAt: '2026-10-01T04:30:00Z' })).toEqual({ keep: false, reason: 'otp' });
      }
    }
  });

  it('a code planted in any position of a real alert is caught', () => {
    for (const [, body] of REAL_ALERTS) {
      const words = body.split(' ');
      for (let i = 0; i <= words.length; i++) {
        // right after a currency word the number IS an amount ("Rs 482913") — nothing can tell them apart
        if (i > 0 && /^(rs\.?|lkr|usd)$/i.test(words[i - 1]!)) continue;
        const planted = [...words.slice(0, i), '482913', ...words.slice(i)].join(' ');
        expect(isSecret(planted), planted).toBe(true);
      }
    }
  });

  it('normalises other digit scripts, full-width forms and invisible characters', () => {
    expect(normaliseForSecrets(`A${digits(0x0de6, '0123456789')}`)).toBe('a0123456789');
    expect(normaliseForSecrets('ＯＴＰ‍１２')).toBe('otp12');
  });

  it('does not mistake ordinary words for secret words', () => {
    for (const text of ['Spinach Rs 120.00', 'Cr Crd no..**6577 Auth Pmt LKR 1.00 at TACO BELL Avl Bal LKR 1.00', 'Contact us']) {
      expect(isSecret(text), text).toBe(false);
    }
  });
});

describe('phone-side text filter (Java regex, tried here as JavaScript)', () => {
  const re = new RegExp(FORWARD_TEXT_REGEX.replace(/^\(\?[a-z]+\)/, ''), 'isu');
  it('blocks every corpus text that has OTP wording', () => {
    // (a word broken by an invisible character is caught by the server, after normalising)
    const worded = SECRET_CORPUS.filter((t) => secretReason(t) === 'keyword' && !/[\u200B\u2060\uFEFF]/.test(t));
    for (const text of worded) {
      expect(re.test(text), text).toBe(false);
    }
  });
  it('forwards every real alert', () => {
    for (const [, body] of REAL_ALERTS) expect(re.test(body), body).toBe(true);
  });
});

describe('the database runs the same corpus', () => {
  it('supabase/tests/database/sms_secret.test.sql was regenerated from this corpus', () => {
    const sql = readFileSync(new URL('../../../../../supabase/tests/database/sms_secret.test.sql', import.meta.url), 'utf8');
    expect(sql, 'run: node --experimental-strip-types scripts/secret-sql-test.mjs')
      .toContain(`select plan(${SECRET_CORPUS.length + REAL_ALERTS.length + 3});`);
  });
});
