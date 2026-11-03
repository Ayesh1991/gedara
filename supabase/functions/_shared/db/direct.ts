// Direct Postgres for the device long-polls (speaker and Home Assistant bridge).
//
// Through supabase-js every RPC is an HTTPS request to PostgREST, and the API gateway logs each one:
// a quiet speaker cost ~7 logged rows every 25 s, about 20 MB of the free plan's 1 GB Log Ingestion a
// day. Here the same service-role-only RPCs run on a Postgres connection (SUPABASE_DB_URL, given to
// every Edge Function) that the gateway never sees. Each call is its own transaction with
// `set local role service_role`, so it has exactly the rights it has through PostgREST.
//
// If the database can't be reached this way (no URL, a connection error), `rpc` falls back to
// supabase-js for a minute: the devices keep working, they only log more. Database errors (42501
// not allowed, GDRTE slow down …) are returned as they are, with their code, like supabase-js.
import postgres from 'npm:postgres@3.4.7';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';

export type RpcArg = { value: unknown; type: 'text' | 'integer' | 'jsonb' };
export type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

const NAME = /^rpc_[a-z_]{1,60}$/;
const RETRY_MS = 60_000;

let sql: postgres.Sql | null | undefined;
let brokenUntil = 0;

function client(): postgres.Sql | null {
  if (sql === undefined) {
    const url = Deno.env.get('SUPABASE_DB_URL') ?? '';
    // One connection per worker, kept while requests come (a long-poll reuses it), closed when idle;
    // prepare: false so it also works through the transaction pooler.
    sql = url ? postgres(url, { max: 1, prepare: false, idle_timeout: 60, connect_timeout: 5, onnotice: () => {} }) : null;
  }
  return sql;
}

/** 'direct' when calls go straight to Postgres, 'rest' when they go through PostgREST. */
export function dbPath(): 'direct' | 'rest' {
  return client() && Date.now() >= brokenUntil ? 'direct' : 'rest';
}

/** For the health check (GET): can Postgres be reached directly right now? */
export async function dbCheck(): Promise<'direct' | 'rest'> {
  const c = client();
  if (!c || Date.now() < brokenUntil) return 'rest';
  try {
    await c`select 1`;
    return 'direct';
  } catch {
    brokenUntil = Date.now() + RETRY_MS;
    return 'rest';
  }
}

/** One public RPC, as `db.rpc(name, args)` would call it, straight in Postgres when it can. */
export async function rpc(db: SupabaseClient, name: string, args: Record<string, RpcArg>): Promise<RpcResult> {
  if (!NAME.test(name)) throw new Error('bad rpc name');
  const c = client();
  if (c && Date.now() >= brokenUntil) {
    const keys = Object.keys(args);
    if (keys.every((k) => /^p(_[a-z]{1,30})?$/.test(k))) {
      const list = keys.map((k, i) => `${k} => $${i + 1}::${args[k].type}`).join(', ');
      const params = keys.map((k) => (args[k].type === 'jsonb' ? JSON.stringify(args[k].value) : args[k].value));
      try {
        const rows = await c.begin(async (tx) => {
          await tx.unsafe('set local role service_role');
          return await tx.unsafe(`select public.${name}(${list}) as r`, params as postgres.ParameterOrJSON<never>[]);
        });
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        if (e instanceof postgres.PostgresError) return { data: null, error: { code: e.code, message: e.message } };
        brokenUntil = Date.now() + RETRY_MS; // the connection, not the call: PostgREST for a minute
        console.log(JSON.stringify({ db: 'direct', error: e instanceof Error ? (e as { code?: string }).code ?? e.name : 'unknown' }));
      }
    }
  }
  const plain = Object.fromEntries(Object.entries(args).map(([k, a]) => [k, a.value]));
  const { data, error } = await db.rpc(name, plain);
  return { data, error: error ? { code: error.code, message: error.message } : null };
}
