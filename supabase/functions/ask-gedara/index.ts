// ask-gedara — Ask Gedara (Phase 10): a question in plain words → a plan of read-only ask_* calls.
//
//   GET                                          → { ok, fn_version, keys: { groq, openai } } (set or not; never a key)
//   POST + the asker's JWT, body { household_id, request_id, question }
//                                                → { plan, provider, model, used, limit, today }
//
// The AI sees only the fixed instructions, today's date and the checked question — never the household's
// data; the browser runs the plan with the asker's own login (RLS). All the work is in ../_shared/ask
// (handler.ts, tested with vitest). Secrets: GROQ_API_KEY, OPENAI_API_KEY (already set for matching);
// ASK_OFF=1 stops it at once (scripts/ask-switch.mjs). No service role. Logs: one line per request,
// counts and codes only. Bump FN_VERSION (in handler.ts) on every deploy.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { callModel } from '../_shared/ai/providers.ts';
import { handleAsk, type AskDb } from '../_shared/ask/handler.ts';

Deno.serve((req) =>
  handleAsk(req, {
    env: (name) => Deno.env.get(name),
    userDb: (authorization) =>
      createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as AskDb,
    callModel: (ref, input, keys, timeoutMs) => callModel(ref, input, keys, fetch, timeoutMs),
    now: () => Date.now(),
    log: (line) => console.log(line),
  }),
);
