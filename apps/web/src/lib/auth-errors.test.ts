import { describe, expect, it } from 'vitest';
import { otpErrorKey } from './auth-errors';

describe('otpErrorKey', () => {
  it('treats disabled sign-up as "not invited"', () => {
    expect(otpErrorKey({ code: 'otp_disabled', status: 422 }, 'send')).toBe('login.errors.notInvited');
    expect(otpErrorKey({ message: 'Signups not allowed for otp' }, 'send')).toBe('login.errors.notInvited');
  });

  it('detects rate limits in both steps', () => {
    expect(otpErrorKey({ status: 429 }, 'send')).toBe('login.errors.rateLimited');
    expect(otpErrorKey({ code: 'over_email_send_rate_limit' }, 'verify')).toBe('login.errors.rateLimited');
  });

  it('maps expired or wrong codes', () => {
    expect(otpErrorKey({ code: 'otp_expired', status: 403 }, 'verify')).toBe('login.errors.badCode');
    expect(otpErrorKey({ message: 'Token has expired or is invalid' }, 'verify')).toBe('login.errors.badCode');
  });

  it('falls back to generic', () => {
    expect(otpErrorKey({ message: 'network down' }, 'send')).toBe('login.errors.generic');
  });
});
