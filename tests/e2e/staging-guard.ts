import { createClient } from '@supabase/supabase-js';

/**
 * e2e may only ever touch gedara-staging. It uses the staging service-role key (from .env.local,
 * never from apps/web) to mint a login code with auth.admin.generateLink — no email is sent.
 */
export function stagingAdmin() {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const allowedRef = process.env.E2E_STAGING_REF ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url)?.[1];
  if (!allowedRef || ref !== allowedRef) {
    throw new Error(
      `Refusing to run e2e: VITE_SUPABASE_URL ref "${ref ?? '?'}" is not E2E_STAGING_REF "${allowedRef || '(unset)'}".`,
    );
  }
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY (staging) missing from .env.local');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const E2E_EMAIL = process.env.E2E_EMAIL ?? 'ayeshmantha@gmail.com';

export async function mintOtp(email = E2E_EMAIL): Promise<string> {
  const { data, error } = await stagingAdmin().auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const otp = data.properties?.email_otp;
  if (!otp) throw new Error('generateLink returned no email_otp');
  return otp;
}
