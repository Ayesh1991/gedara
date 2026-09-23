import { z } from 'zod';

const EnvSchema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
  VITE_APP_ENV: z.enum(['local', 'staging', 'prod']).default('local'),
  VITE_PUBLIC_BASE_URL: z.url().default('https://gedara.vercel.app'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}

export const env = parseEnv(import.meta.env);
