-- Ask Gedara core (Phase 10, migration 99): the owner's switch (off by default), each person's daily
-- limit, the shared monthly AI cap, Groq/OpenAI only, the pending row that stops parallel questions,
-- usage recorded as counts only, and household isolation.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e3001', 'askc-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000e3002', 'askc-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000e3003', 'askc-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000e4001', 'askc-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000e30aa', 'AskC A'),
  ('00000000-0000-0000-0000-0000000e40bb', 'AskC B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3001', 'owner'),
  ('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3002', 'member'),
  ('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3003', 'viewer'),
  ('00000000-0000-0000-0000-0000000e40bb', '00000000-0000-0000-0000-0000000e4001', 'owner');

select ok((select string_agg(column_name, ',' order by column_name) from information_schema.columns
            where table_schema = 'public' and table_name = 'ai_usage')
          = 'at,cost_usd,error,household_id,id,input_tokens,model,ok,output_tokens,provider,request_id,run_id,task,user_id',
  'ai_usage has no column that could hold a question or an answer');

set local role authenticated;

-- ── Off by default ────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3003","role":"authenticated"}';
select is((select rpc_ask_status('00000000-0000-0000-0000-0000000e30aa') ->> 'enabled'), 'false', 'Ask is off by default');
select throws_ok($$select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01')$$,
  'GDAOF', null, 'nobody can ask while it is off');

-- ── Only the owner switches it on ─────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3002","role":"authenticated"}';
select throws_ok($$select rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_enabled": true}')$$,
  '42501', null, 'a member can''t switch Ask on');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3001","role":"authenticated"}';
select throws_ok($$select rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_enabled": true, "steps": []}')$$,
  '22023', null, 'unknown settings are refused');
select throws_ok($$select rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_daily_per_person": 101}')$$,
  '22023', null, 'the daily limit is 0 to 100');
select throws_ok($$select rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_enabled": "yes"}')$$,
  '22023', null, 'the switch must be true or false');
select is(rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_enabled": true, "ask_daily_per_person": 2}'),
  '{"ask_enabled": true, "ask_daily_per_person": 2}'::jsonb, 'the owner switches Ask on with 2 questions a day each');
select throws_ok($$update match_setting set ask_enabled = false$$, '42501', null, 'the settings row isn''t client-writable');

-- ── A viewer asks ─────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3003","role":"authenticated"}';
select is((select (r ->> 'used') || '/' || (r ->> 'limit') || ' ' || jsonb_array_length(r -> 'steps') || ' '
                  || (r -> 'steps' -> 0 ->> 'provider') || ' ' || (r -> 'steps' -> 1 ->> 'provider')
             from (select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01') as r) x),
  '1/2 2 groq openai', 'a viewer may ask; only Groq then OpenAI (never Gemini)');
select is((select provider || ' ' || ok || ' ' || error || ' ' || (user_id = auth.uid()) from ai_usage
            where request_id = '00000000-0000-0000-0000-0000000e3a01'),
  'groq false pending true', 'a pending row is written before any AI call');
select throws_ok($$select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01')$$,
  '22023', null, 'a request id can''t be reused');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01',
  '[{"provider":"gemini","model":"gemini-3.8-flash","input_tokens":1,"output_tokens":1,"cost_usd":0,"ok":true}]')$$,
  '22023', null, 'Gemini can''t be recorded for Ask');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01',
  '[{"provider":"openai","model":"gpt-6-luna","input_tokens":1,"output_tokens":1,"cost_usd":0.2,"ok":true}]')$$,
  '22023', null, 'one question can''t claim more than US$0.05');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01',
  '[{"provider":"groq","model":"openai/gpt-oss-120b","input_tokens":1,"output_tokens":1,"cost_usd":0,"ok":false,"error":"How much fish?"}]')$$,
  '22023', null, 'the error is a short code, never text');
select lives_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01',
  '[{"provider":"groq","model":"openai/gpt-oss-120b","input_tokens":1500,"output_tokens":90,"cost_usd":0,"ok":false,"error":"http_429"},
    {"provider":"openai","model":"gpt-6-luna","input_tokens":1500,"output_tokens":120,"cost_usd":0.00021,"ok":true}]')$$,
  'the function records both model calls');
select is((select string_agg(provider || ':' || ok || ':' || coalesce(error, '-') || ':' || cost_usd, ' ' order by ok) from ai_usage
            where request_id = '00000000-0000-0000-0000-0000000e3a01'),
  'groq:false:http_429:0.000000 openai:true:-:0.000210', 'one row per model call, counts and cost only');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a01',
  '[{"provider":"groq","model":"openai/gpt-oss-120b","input_tokens":1,"output_tokens":1,"cost_usd":0,"ok":true}]')$$,
  '22023', null, 'a question is recorded once');
select is((select (r ->> 'used') from (select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a02') as r) x),
  '2', 'the second question of the day');
select throws_ok($$select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a03')$$,
  'GDRTE', null, 'the third is over the viewer''s daily limit');
select is((select (rpc_ask_status('00000000-0000-0000-0000-0000000e30aa') ->> 'used')), '2', 'status shows 2 used today');

-- ── The limit is per person ───────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3002","role":"authenticated"}';
select is((select (r ->> 'used') from (select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a04') as r) x),
  '1', 'the member still has their own questions');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a02',
  '[{"provider":"groq","model":"openai/gpt-oss-120b","input_tokens":1,"output_tokens":1,"cost_usd":0,"ok":true}]')$$,
  '22023', null, 'nobody can record someone else''s question');

-- ── The monthly cap is shared with Matching ──────────────────────────────────
reset role;
insert into ai_usage (household_id, provider, model, task, cost_usd, ok)
values ('00000000-0000-0000-0000-0000000e30aa', 'gemini', 'gemini-3.8-flash', 'sms_link', 1.00, true);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e3001","role":"authenticated"}';
select throws_ok($$select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a05')$$,
  'GDCAP', null, 'over the monthly AI cap (matching counts too), Ask stops');
select is((select (rpc_ask_status('00000000-0000-0000-0000-0000000e30aa') ->> 'month_cost_usd')::numeric), 1.000210,
  'status shows the month''s AI cost, matching and Ask together');

-- ── Household B ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e4001","role":"authenticated"}';
select throws_ok($$select rpc_ask_begin('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3b01')$$,
  '42501', null, 'B can''t ask about A');
select throws_ok($$select rpc_ask_status('00000000-0000-0000-0000-0000000e30aa')$$, '42501', null, 'B can''t read A''s status');
select throws_ok($$select rpc_ask_settings_save('00000000-0000-0000-0000-0000000e30aa', '{"ask_enabled": false}')$$,
  '42501', null, 'B can''t change A''s switch');
select throws_ok($$select rpc_ask_record('00000000-0000-0000-0000-0000000e30aa', '00000000-0000-0000-0000-0000000e3a04',
  '[{"provider":"groq","model":"openai/gpt-oss-120b","input_tokens":1,"output_tokens":1,"cost_usd":0,"ok":true}]')$$,
  '42501', null, 'B can''t record A''s question');
select is((select count(*)::int from ai_usage where household_id = '00000000-0000-0000-0000-0000000e30aa'), 0,
  'B can''t read A''s AI usage');

select * from finish();
rollback;
