import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/db.types';

export type CheckId = 'auth' | 'db' | 'storage' | 'realtime' | 'edge' | 'sw';

export const CHECK_IDS: readonly CheckId[] = ['auth', 'db', 'storage', 'realtime', 'edge', 'sw'];

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
}

/** Thrown by a check to report a failure with an i18n key instead of raw text. */
export class CheckError extends Error {
  constructor(
    public readonly key: string,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(key);
  }
}

export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`timeout ${ms}`);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Runs one check; never throws. `detail` is what the check returned on success. */
export async function runCheck(
  id: CheckId,
  fn: () => Promise<string | undefined>,
  opts: { timeoutMs: number; t: Translate; now?: () => number },
): Promise<CheckResult> {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  try {
    const detail = await withTimeout(fn(), opts.timeoutMs);
    return { id, ok: true, ms: Math.round(now() - start), detail };
  } catch (e) {
    const ms = Math.round(now() - start);
    if (e instanceof TimeoutError) {
      return { id, ok: false, ms, error: opts.t('diagnostics.errors.timeout', { ms: e.ms }) };
    }
    if (e instanceof CheckError) {
      return { id, ok: false, ms, error: opts.t(e.key, e.params) };
    }
    return { id, ok: false, ms, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface CheckDeps {
  supabase: SupabaseClient<Database>;
  appVersion: string;
  getSwVersion: () => Promise<string | null>;
}

/** The six Test-connection checks. Each resolves to a short detail string or throws. */
export function buildChecks({ supabase, appVersion, getSwVersion }: CheckDeps): Record<
  CheckId,
  () => Promise<string | undefined>
> {
  return {
    auth: async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error) throw error;
      if (!data.user) throw new CheckError('diagnostics.errors.noSession');
      return data.user.email ?? data.user.id;
    },

    db: async () => {
      const [version, household] = await Promise.all([
        supabase.rpc('schema_version'),
        supabase.from('household').select('id, name').limit(1).maybeSingle(),
      ]);
      if (version.error) throw version.error;
      if (household.error) throw household.error;
      if (!household.data) throw new CheckError('diagnostics.errors.noHousehold');
      return `schema ${version.data} · ${household.data.name}`;
    },

    storage: async () => {
      const household = await supabase.from('household').select('id').limit(1).maybeSingle();
      if (household.error) throw household.error;
      if (!household.data) throw new CheckError('diagnostics.errors.noHousehold');
      const { data, error } = await supabase.storage
        .from('household-files')
        .list(household.data.id, { limit: 1 });
      if (error) throw error;
      return `household-files · ${data.length} item(s)`;
    },

    realtime: () =>
      new Promise<string>((resolve, reject) => {
        const channel = supabase.channel(`diagnostics-${crypto.randomUUID()}`);
        channel.subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            void supabase.removeChannel(channel);
            resolve(status);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            void supabase.removeChannel(channel);
            reject(err ?? new Error(status));
          }
        });
      }),

    edge: async () => {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; fn_version: string }>(
        'ping',
        { method: 'POST', body: {} },
      );
      if (error) throw error;
      if (!data?.ok) throw new Error('ping returned no ok');
      return data.fn_version;
    },

    sw: async () => {
      const swVersion = await getSwVersion();
      if (!swVersion) throw new CheckError('diagnostics.errors.noController');
      if (swVersion !== appVersion) {
        throw new CheckError('diagnostics.errors.swMismatch', { sw: swVersion, app: appVersion });
      }
      return `v${swVersion}`;
    },
  };
}
