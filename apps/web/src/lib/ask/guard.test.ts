import { describe, expect, it } from 'vitest';
import { assertAskUser, buildUser, questionCheck, UnsafeAsk } from '@ask/guard';
import { SECRET_CORPUS } from '@/lib/__fixtures__/secretCorpus';

// Phase 10 · what may leave Gedara for an AI: only the checked question (plus the fixed instructions and
// today's date). OTPs, card/account numbers and code-like numbers never do; e-mail addresses are masked.

describe('questionCheck', () => {
  it.each(SECRET_CORPUS)('refuses every OTP / password text of the shared corpus: %s', (text) => {
    expect(questionCheck(text).ok).toBe(false);
  });

  it.each([
    'How much did we spend on fish since June?',
    'What did we spend at Keells in 2026?',
    'Did we spend more than Rs 50,000 on groceries?',
    'Any bill over 25000 rupees last month?',
    'Payments above LKR 120000 this year',
    'How much rice is left, do we have 2 kg?',
    'Spending in the last 30 days',
    'How much do we owe on the Seylan card 6029?',
    'Spend from 2026-06-01 to 2026-07-31',
    'Fuel between 1/6/2026 and 31/7/2026',
    'Is the electricity bill more than 12,500.50?',
    'ජූනි සිට මාළු වලට කීයක් වියදම් කළාද?',
    'මේ මාසේ ගෙවන්න තියෙන්නේ මොනවද?',
    'When does the Toyota instalment end?',
    'Did we spend over 5000 on fish?',
    'Bills of 3500 last month',
    'BOC ··708 balance',
    '5000 ට වඩා වියදම් කළ බිල් මොනවද?',
    'Top 10 shops in 2025',
  ])('lets an ordinary question through unchanged: %s', (text) => {
    expect(questionCheck(text)).toEqual({ ok: true, text });
  });

  it.each([
    ['What is 4111 1111 1111 1111 used for?', 'card'],
    ['Balance of account 0081234567890', 'card'],
    ['Payments to 0112-300-604-55', 'card'],
    ['What is 482913?', 'code'],
    ['What is 4829 for?', 'code'],
    ['Enter 482-913', 'code'],
    ['Did 77120 come in?', 'code'],
    ['Show my OTP', 'otp'],
    ['What is the PIN for the BOC card?', 'otp'],
    ['මගේ මුරපදය මොකක්ද?', 'otp'],
  ])('refuses %s (%s)', (text, reason) => {
    expect(questionCheck(text)).toEqual({ ok: false, reason });
  });

  it('masks e-mail addresses', () => {
    expect(questionCheck('What did sandeepani@example.com buy?')).toEqual({ ok: true, text: 'What did [email] buy?' });
  });

  it('trims, removes invisible characters and refuses empty or long questions', () => {
    expect(questionCheck('  fish​  spend \n ')).toEqual({ ok: true, text: 'fish spend' });
    expect(questionCheck('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(questionCheck(42)).toEqual({ ok: false, reason: 'empty' });
    expect(questionCheck('x'.repeat(301))).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('assertAskUser (the last gate before fetch)', () => {
  it('passes exactly { today, question } with a checked question', () => {
    expect(() => assertAskUser(buildUser('2026-11-03', 'How much on fish since June?'))).not.toThrow();
  });

  it.each([
    ['extra data', JSON.stringify({ today: '2026-11-03', question: 'fish', rows: [{ amount: 1200 }] })],
    ['no date', JSON.stringify({ question: 'fish' })],
    ['bad date', JSON.stringify({ today: 'yesterday', question: 'fish' })],
    ['an OTP', JSON.stringify({ today: '2026-11-03', question: 'Your OTP is 482913' })],
    ['an unchecked question', JSON.stringify({ today: '2026-11-03', question: '  fish  ' })],
    ['an e-mail address', JSON.stringify({ today: '2026-11-03', question: 'what did a@b.co buy' })],
    ['not JSON', 'fish'],
    ['an array', '[]'],
  ])('refuses %s', (_name, user) => {
    expect(() => assertAskUser(user)).toThrow(UnsafeAsk);
  });
});
