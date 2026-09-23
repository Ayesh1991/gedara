import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from './supabase';

// role is a CHECK-constrained text column, so generated types say string; narrow it here.
const RoleSchema = z.enum(['owner', 'member', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export interface Membership {
  userId: string;
  email: string;
  role: Role;
  displayName: string | null;
  household: { id: string; name: string; currency: string; locale: string; timezone: string };
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** The signed-in user's household (null = signed in but not invited anywhere). */
export const membershipQuery = queryOptions({
  queryKey: ['membership'],
  queryFn: async (): Promise<Membership | null> => {
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await supabase
      .from('household_member')
      .select('role, display_name, household:household_id (id, name, currency, locale, timezone)')
      .eq('user_id', session.user.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data?.household) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? '',
      role: RoleSchema.parse(data.role),
      displayName: data.display_name,
      household: data.household,
    };
  },
  staleTime: 5 * 60 * 1000,
});

/** DB schema_version for the badge; callable before login. */
export const schemaVersionQuery = queryOptions({
  queryKey: ['schema_version'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('schema_version');
    if (error) throw error;
    return data;
  },
  staleTime: 10 * 60 * 1000,
  retry: 1,
});
