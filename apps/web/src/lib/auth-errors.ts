/** Maps Supabase Auth errors from the OTP flow to i18n keys. */
export function otpErrorKey(
  error: { code?: string; status?: number; message?: string },
  step: 'send' | 'verify',
) {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  if (error.status === 429 || code.startsWith('over_') || message.includes('rate limit')) {
    return 'login.errors.rateLimited' as const;
  }
  if (
    step === 'send' &&
    (code === 'otp_disabled' || code === 'signup_disabled' || message.includes('signups not allowed'))
  ) {
    return 'login.errors.notInvited' as const;
  }
  if (
    step === 'verify' &&
    (code === 'otp_expired' ||
      code === 'invalid_credentials' ||
      message.includes('expired') ||
      message.includes('invalid'))
  ) {
    return 'login.errors.badCode' as const;
  }
  return 'login.errors.generic' as const;
}
