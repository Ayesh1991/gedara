import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { LockKeyhole } from 'lucide-react';
import { EnvChip, LogoMark } from '@/components/Brand';
import { VersionBadge } from '@/components/VersionBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPSlot } from '@/components/ui/input-otp';
import { otpErrorKey } from '@/lib/auth-errors';
import { getSession } from '@/lib/queries';
import { safeRedirect } from '@/lib/redirect';
import { supabase } from '@/lib/supabase';

const RESEND_SECONDS = 60;
const OTP_SLOTS = [0, 1, 2, 3, 4, 5];
const emailSchema = z.email();

const SearchSchema = z.object({ redirect: z.string().optional() });

export const Route = createFileRoute('/login')({
  validateSearch: SearchSchema,
  beforeLoad: async ({ search }) => {
    if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { queryClient } = Route.useRouteContext();
  const { redirect: returnTo } = Route.useSearch();
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
    await navigate({ href: safeRedirect(returnTo), replace: true });
  }

  return (
    <div className="pt-safe pb-safe relative z-10 flex min-h-dvh flex-col items-center px-5 sm:justify-center">
      <div className="mt-16 flex w-full max-w-sm flex-col items-center gap-10 sm:mt-0">
        <div className="flex flex-col items-center gap-4">
          <LogoMark size={76} />
          <div className="flex flex-col items-center gap-1">
            <span className="font-display text-[34px] leading-none font-bold tracking-tight">{t('app.name')}</span>
            <span className="text-base text-[#a5b0d0]">
              {t('app.subtitle')} · {t('app.tagline')}
            </span>
            <EnvChip />
          </div>
        </div>

        <div className="glass w-full space-y-5 rounded-[26px] p-6">
          {step === 'email' ? (
            <form onSubmit={(e) => void sendCode(e)} className="space-y-5" noValidate>
              <div className="space-y-1.5">
                <h1 className="font-display text-[22px] font-semibold">{t('login.title')}</h1>
                <p className="text-sm leading-relaxed text-[#a5b0d0]">{t('login.intro')}</p>
              </div>
              <label className="block space-y-2">
                <span className="text-[13px] text-[#a5b0d0]">{t('login.email')}</span>
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
              <Button type="submit" variant="primary" className="h-[54px] w-full rounded-2xl text-base" disabled={busy}>
                {busy ? t('login.sending') : t('login.sendCode')}
              </Button>
            </form>
          ) : (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6) void verify(code);
              }}
            >
              <div className="space-y-1.5">
                <h1 className="font-display text-[22px] font-semibold">{t('login.codeTitle')}</h1>
                <p className="text-sm leading-relaxed text-[#a5b0d0]">{t('login.codeSent', { email })}</p>
              </div>
              <div className="space-y-2">
                <span className="text-[13px] text-[#a5b0d0]">{t('login.code')}</span>
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
              <Button
                type="submit"
                variant="primary"
                className="h-[54px] w-full rounded-2xl text-base"
                disabled={busy || code.length !== 6}
              >
                {busy ? t('login.verifying') : t('login.verify')}
              </Button>
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" className="px-0 font-normal text-[#a5b0d0]" onClick={() => setStep('email')}>
                  {t('login.changeEmail')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="tabular px-0 font-normal text-[#a5b0d0]"
                  disabled={cooldown > 0 || busy}
                  onClick={() => void sendCode()}
                >
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
        </div>

        <div className="flex flex-col items-center gap-1.5 pb-6">
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
            {t('login.footer')}
          </span>
          <VersionBadge linked={false} />
        </div>
      </div>
    </div>
  );
}
