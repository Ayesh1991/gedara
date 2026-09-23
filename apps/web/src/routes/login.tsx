import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Brand } from '@/components/Brand';
import { VersionBadge } from '@/components/VersionBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPSlot } from '@/components/ui/input-otp';
import { otpErrorKey } from '@/lib/auth-errors';
import { getSession } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

const RESEND_SECONDS = 60;
const OTP_SLOTS = [0, 1, 2, 3, 4, 5];
const emailSchema = z.email();

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await getSession()) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { queryClient } = Route.useRouteContext();
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    const parsed = emailSchema.safeParse(email.trim().toLowerCase());
    if (!parsed.success) {
      setError(t('login.errors.invalidEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    // shouldCreateUser: false — invite-only; Auth rejects emails that don't have an account.
    const { error: err } = await supabase.auth.signInWithOtp({
      email: parsed.data,
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (err) {
      setError(t(otpErrorKey(err, 'send'), { message: err.message }));
      return;
    }
    setEmail(parsed.data);
    setStep('code');
    setCode('');
    setCooldown(RESEND_SECONDS);
  }

  async function verify(token: string) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (err) {
      setBusy(false);
      setCode('');
      setError(t(otpErrorKey(err, 'verify'), { message: err.message }));
      return;
    }
    await queryClient.invalidateQueries();
    setBusy(false);
    await navigate({ to: '/' });
  }

  return (
    <div className="pt-safe pb-safe flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <Brand />
        <Card className="space-y-4">
          <h1 className="font-display text-xl font-semibold">{t('login.title')}</h1>

          {step === 'email' ? (
            <form onSubmit={(e) => void sendCode(e)} className="space-y-4" noValidate>
              <p className="text-sm text-muted">{t('login.intro')}</p>
              <label className="block space-y-1.5">
                <span className="text-sm">{t('login.email')}</span>
                <Input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t('login.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? t('login.sending') : t('login.sendCode')}
              </Button>
            </form>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6) void verify(code);
              }}
            >
              <p className="text-sm text-muted">{t('login.codeSent', { email })}</p>
              <div className="space-y-1.5">
                <span className="text-sm">{t('login.code')}</span>
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={setCode}
                  onComplete={(v: string) => void verify(v)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="^[0-9]+$"
                  disabled={busy}
                  autoFocus
                  aria-label={t('login.code')}
                >
                  {OTP_SLOTS.map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTP>
              </div>
              <Button type="submit" variant="primary" className="w-full" disabled={busy || code.length !== 6}>
                {busy ? t('login.verifying') : t('login.verify')}
              </Button>
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep('email')}>
                  {t('login.changeEmail')}
                </Button>
                <Button variant="ghost" size="sm" disabled={cooldown > 0 || busy} onClick={() => void sendCode()}>
                  {cooldown > 0 ? t('login.resendIn', { seconds: cooldown }) : t('login.resend')}
                </Button>
              </div>
            </form>
          )}

          {error && (
            <p role="alert" className="text-sm text-red">
              {error}
            </p>
          )}
        </Card>
        <div className="text-center">
          <VersionBadge linked={false} />
        </div>
      </div>
    </div>
  );
}
