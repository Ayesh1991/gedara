import { createClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { env } from './env';

// Anon key only — everything is protected by RLS. The service-role key never lives in apps/web.
export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
