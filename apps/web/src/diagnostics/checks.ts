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
        let settled = false;
        // Settle BEFORE removing: removeChannel synchronously re-enters this callback with CLOSED,
        // and removing again from inside it would loop (phx_leave storm, stack overflow).
        channel.subscribe((status, err) => {
          if (settled) return;
          if (status === 'SUBSCRIBED') {
            settled = true;
            resolve(status);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            settled = true;
            reject(err ?? new Error(status));
          } else {
            return;
          }
          void supabase.removeChannel(channel);
        });
      }),

    edge: async () => {
      // All at once: each may be a cold start, and in a row they could pass the 8 s limit.
      const [ping, sms, push, drive] = await Promise.all([
        supabase.functions.invoke<{ ok: boolean; fn_version: string }>('ping', { method: 'POST', body: {} }),
        // Bank-SMS ingest (Phase 2b): its version answers a plain GET.
        supabase.functions.invoke<{ ok: boolean; fn_version: string }>('sms-ingest', { method: 'GET' }),
        // Daily Attention push (Phase 6): its version, and whether the VAPID keys are set.
        supabase.functions.invoke<{ ok: boolean; fn_version: string; vapid_public_key: string | null }>('attention-push', {
          method: 'GET',
        }),
        // Scanner files from Drive (Phase 7): its version, and whether the Google secrets are set.
        supabase.functions.invoke<{ ok: boolean; fn_version: string; configured: boolean }>('drive-scan', { method: 'GET' }),
      ]);
      if (ping.error) throw ping.error;
      if (!ping.data?.ok) throw new Error('ping returned no ok');
      if (sms.error || !sms.data?.ok) throw new CheckError('diagnostics.errors.smsIngest');
      if (push.error || !push.data?.ok) throw new CheckError('diagnostics.errors.attentionPush');
      if (!push.data.vapid_public_key) throw new CheckError('diagnostics.errors.pushKeys');
      if (drive.error || !drive.data?.ok) throw new CheckError('diagnostics.errors.driveScan');
      if (!drive.data.configured) throw new CheckError('diagnostics.errors.driveKeys');
      return `${ping.data.fn_version} · ${sms.data.fn_version} · ${push.data.fn_version} · ${drive.data.fn_version}`;
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
