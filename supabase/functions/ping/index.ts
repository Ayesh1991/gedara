// ping — Diagnostics "Edge fn ✓" check.
// JWT-verified by the platform (verify_jwt = true), so reaching this handler also proves the
// caller's session is valid. Bump FN_VERSION on every deploy of this function.
import { createClient } from 'npm:@supabase/supabase-js@2';

const FN_VERSION = 'ping-1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data } = await supabase.auth.getUser();

  return new Response(
    JSON.stringify({
      ok: true,
      fn_version: FN_VERSION,
      time: new Date().toISOString(),
      user_id: data.user?.id ?? null,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
