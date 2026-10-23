-- Phase 9b: matching in shadow. Settings (owner only), "Check now" / import / eval limits, the
-- service-role bundle (never an SMS body) and save (a person's decision is kept unless the input
-- changed), decisions, accuracy views, line actions (product without new stock, not-pantry, category
-- + learning), the Attention item, the cron gate, and household isolation of every new table.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(46);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fd101', 'match-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fd102', 'match-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000fd103', 'match-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fe101', 'match-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fd1aa', 'Match A'),
  ('00000000-0000-0000-0000-0000000fe1bb', 'Match B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd101', 'owner'),
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd102', 'member'),
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fe1bb', '00000000-0000-0000-0000-0000000fe101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fd0c1', '00000000-0000-0000-0000-0000000fd1aa', 'grocery', 'Grocery', 'stock'),
  ('00000000-0000-0000-0000-0000000fd0c3', '00000000-0000-0000-0000-0000000fd1aa', 'services', 'Services', 'expense'),
  ('00000000-0000-0000-0000-0000000fe0c1', '00000000-0000-0000-0000-0000000fe1bb', 'grocery', 'Grocery B', 'stock');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000fd0c2', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd0c3', 'Other service');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-0000000fd0a1', '00000000-0000-0000-0000-0000000fd1aa', 'Cash', 'cash'),
  ('00000000-0000-0000-0000-0000000fe0a1', '00000000-0000-0000-0000-0000000fe1bb', 'Cash B', 'cash');
insert into product (id, household_id, name, stock_unit_id, due_type) values
  ('00000000-0000-0000-0000-0000000fd0d1', '00000000-0000-0000-0000-0000000fd1aa', 'Keeri samba', pg_temp.u('g'), 'none'),
  ('00000000-0000-0000-0000-0000000fe0d1', '00000000-0000-0000-0000-0000000fe1bb', 'Rice B', pg_temp.u('g'), 'none');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint, source) values
  ('00000000-0000-0000-0000-0000000fd0e1', '00000000-0000-0000-0000-0000000fd1aa', 'expense', '00000000-0000-0000-0000-0000000fd0a1',
   'Cargills', current_date - 3, 1800, 'bmatch1', 'scan');
insert into transaction_line (id, household_id, transaction_id, line_no, raw_name, category_id, amount, destiny, fingerprint) values
  ('00000000-0000-0000-0000-0000000fd0f1', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd0e1', 0,
   'KEERI SMBA 5KG', '00000000-0000-0000-0000-0000000fd0c1', 1200, 'stock', 'bmatch1-0-a'),
  ('00000000-0000-0000-0000-0000000fd0f2', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd0e1', 1,
   'Delivery charge', '00000000-0000-0000-0000-0000000fd0c2', 600, 'expense', 'bmatch1-1-b');
insert into sms_message (id, household_id, channel, sender, received_at, body, fingerprint, parser_version, kind, institution,
                         amount, merchant_text, occurred_on) values
  ('00000000-0000-0000-0000-0000000fd051', '00000000-0000-0000-0000-0000000fd1aa', 'backup', 'Seylan Bank', now() - interval '1 day',
   'Seylan Card ...6029 debit Txn 10357428172 of LKR 1,800.00 done … at CARGILLS LK. Avl bal 1.00', 'smatch1', 2,
   'card_charge', 'Seylan', 1800, 'CARGILLS LK', current_date - 1);

set local role authenticated;

-- ── Settings: owner only ──────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';
select lives_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fd1aa', '{"ai_enabled": true, "monthly_cap_usd": 2}')$$,
  'owner turns AI suggestions on with a $2 cap');
select is((select ai_enabled || ' ' || monthly_cap_usd || ' ' || jsonb_array_length(steps) || ' ' || (steps -> 1 ->> 'model') from match_setting
             where household_id = '00000000-0000-0000-0000-0000000fd1aa'), 'true 2.00 3 gpt-6-luna',
  'saved with the default three-model ladder');
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fd1aa', '{"steps": [{"provider":"evil","model":"x"}]}')$$,
  '23514', null, 'only known providers');
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fd1aa', '{"monthly_cap_usd": 500}')$$,
  '23514', null, 'the cap has a ceiling');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd102","role":"authenticated"}';
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fd1aa', '{"ai_enabled": false}')$$,
  '42501', null, 'a member cannot change the AI settings');

-- ── Asking for runs ───────────────────────────────────────────────────────────
select isnt(rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'user'), null, 'a member presses "Check now"');
select throws_ok($$select rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'user')$$, 'GDRTE', null,
  'not again within a minute');
select throws_ok($$select rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'eval')$$, '42501', null,
  'only the owner runs the accuracy test');
select throws_ok($$select rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'check')$$, '42501', null,
  'only the owner tests the AI keys (paid calls)');
select throws_ok($$select rpc_match_bundle('00000000-0000-0000-0000-0000000fd1aa', (select id from match_run limit 1))$$,
  '42501', null, 'members cannot read a bundle (service role only)');
select throws_ok($$select rpc_match_save('00000000-0000-0000-0000-0000000fd1aa', (select id from match_run limit 1), '{}')$$,
  '42501', null, 'members cannot save a run');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd103","role":"authenticated"}';
select throws_ok($$select rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'import')$$, '42501', null,
  'a viewer cannot start a run');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';
insert into t_c values ('run', to_jsonb(rpc_match_request('00000000-0000-0000-0000-0000000fd1aa', 'import')));

-- ── The function's side (service role) ───────────────────────────────────────
reset role;
insert into t_c values ('token', to_jsonb(private.cron_token()));
set local role service_role;
select throws_ok($$select rpc_match_cron_begin('0000')$$, '42501', null, 'a wrong cron token starts nothing');
insert into t_c values ('cron', rpc_match_cron_begin((select v #>> '{}' from t_c where k = 'token')));
select ok((select v @> jsonb_build_array(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000fd1aa')) from t_c where k = 'cron'),
  'cron opens a run for every household');
insert into t_c values ('bundle', rpc_match_bundle('00000000-0000-0000-0000-0000000fd1aa', (select (v #>> '{}')::uuid from t_c where k = 'run')));
select is((select jsonb_array_length(v -> 'sms') || ' ' || (v -> 'sms' -> 0 ->> 'body') || '|' || (v -> 'sms' -> 0 ->> 'merchant_text')
             from t_c where k = 'bundle'), '1 |CARGILLS LK', 'the bundle carries the alert''s fields but never its text');
select is((select jsonb_array_length(v -> 'lines') || ' ' || jsonb_array_length(v -> 'other_lines') || ' '
                  || (v -> 'lines' -> 0 ->> 'shop') from t_c where k = 'bundle'),
  '1 1 Cargills', 'pantry lines without a product, and lines in an "Other …" category');
select is((select jsonb_array_length(v -> 'products') from t_c where k = 'bundle'), 1, 'only this household''s products');
select throws_ok($$select rpc_match_bundle('00000000-0000-0000-0000-0000000fe1bb', (select (v #>> '{}')::uuid from t_c where k = 'run'))$$,
  '42501', null, 'a run belongs to its household');

select is(rpc_match_save('00000000-0000-0000-0000-0000000fd1aa', (select (v #>> '{}')::uuid from t_c where k = 'run'), jsonb_build_object(
  'suggestions', jsonb_build_array(
    jsonb_build_object('task', 'line_product', 'target_key', 'bmatch1-0-a', 'line_id', '00000000-0000-0000-0000-0000000fd0f1',
      'proposal', jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000fd0d1', 'destiny', 'stock'),
      'confidence', 0.95, 'pattern', 'ai1+ai2', 'models', jsonb_build_array('groq/openai/gpt-oss-120b', 'gemini/gemini-2.5-flash'),
      'input_hash', 'h1'),
    jsonb_build_object('task', 'sms_category', 'target_key', '00000000-0000-0000-0000-0000000fd051',
      'sms_id', '00000000-0000-0000-0000-0000000fd051', 'proposal', jsonb_build_object('category_id', '00000000-0000-0000-0000-0000000fd0c1'),
      'confidence', 0.7, 'pattern', 'ai1', 'models', '[]'::jsonb, 'input_hash', 'h2')),
  'usage', jsonb_build_array(jsonb_build_object('provider', 'gemini', 'model', 'gemini-2.5-flash', 'task', 'lines',
      'input_tokens', 1000, 'output_tokens', 100, 'cost_usd', 0.00055, 'ok', true)),
  'evals', jsonb_build_array(jsonb_build_object('task', 'line_product', 'target_key', 'bmatch1-0-a',
      'truth', jsonb_build_object('product_id', 'x'), 'ai', jsonb_build_object('confidence', 0.95, 'pattern', 'ai1+ai2'),
      'rule_correct', null, 'ai_correct', true)),
  'stats', jsonb_build_object('suggestions', 2))) ->> 'suggestions', '2', 'a run saves its suggestions, usage and accuracy rows');
select throws_ok($$select rpc_match_save('00000000-0000-0000-0000-0000000fd1aa', (select (v #>> '{}')::uuid from t_c where k = 'run'), '{}')$$,
  '42501', null, 'a finished run can''t be saved twice');
select throws_ok($$select rpc_match_save('00000000-0000-0000-0000-0000000fe1bb',
  (select (r ->> 'run_id')::uuid from t_c, jsonb_array_elements(v) r where k = 'cron' and r ->> 'household_id' = '00000000-0000-0000-0000-0000000fd1aa'),
  '{"suggestions": []}')$$, '42501', null, 'nor saved into another household');

-- ── People decide ─────────────────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd102","role":"authenticated"}';
select is((select count(*)::int from match_suggestion where status = 'pending'), 2, 'the member sees two suggestions');
select is((select item_key like 'match:2:%' from attention_feed('00000000-0000-0000-0000-0000000fd1aa') where kind = 'match_review'),
  true, 'Attention says two suggestions wait');
select is(rpc_match_decide(array(select id from match_suggestion where task = 'sms_category'), 'changed',
  '{"category_id": "00000000-0000-0000-0000-0000000fd0c2"}'), 1, 'a member corrects the alert''s category');
select is(rpc_match_decide(array(select id from match_suggestion where task = 'sms_category'), 'rejected'), 0,
  'a decided suggestion is not decided again');
select is((select accepted || ' ' || changed || ' ' || pending from v_match_decisions where task = 'sms_category'), '0 1 0',
  'decisions are counted per task and pattern');
select is((select ai_correct || '/' || ai_answered || ' sure ' || sure_correct || '/' || sure_n from v_match_accuracy where task = 'line_product'),
  '1/1 sure 1/1', 'the accuracy view');
select is((select requests || ' ' || cost_usd from v_ai_cost_month where provider = 'gemini'), '1 0.0006', 'the month''s AI cost');

-- The same input again does not reopen what a person decided; a changed input does.
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';
reset role;
insert into match_run (id, household_id, trigger) values ('00000000-0000-0000-0000-0000000fd0b2', '00000000-0000-0000-0000-0000000fd1aa', 'cron');
set local role service_role;
select lives_ok($$select rpc_match_save('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd0b2', jsonb_build_object(
  'suggestions', jsonb_build_array(
    jsonb_build_object('task', 'sms_category', 'target_key', '00000000-0000-0000-0000-0000000fd051',
      'sms_id', '00000000-0000-0000-0000-0000000fd051', 'proposal', jsonb_build_object('category_id', '00000000-0000-0000-0000-0000000fd0c1'),
      'confidence', 0.7, 'pattern', 'ai1', 'models', '[]'::jsonb, 'input_hash', 'h2'),
    jsonb_build_object('task', 'line_product', 'target_key', 'bmatch1-0-a', 'line_id', '00000000-0000-0000-0000-0000000fd0f1',
      'proposal', jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000fd0d1', 'destiny', 'stock'),
      'confidence', 0.98, 'pattern', 'rule+ai1', 'models', '[]'::jsonb, 'input_hash', 'h1b')),
  'stale', jsonb_build_array(jsonb_build_object('task', 'nothing', 'target_key', 'x'))))$$, 'a later run');
select is((select string_agg(task || ':' || status || ':' || pattern, ', ' order by task) from match_suggestion
             where household_id = '00000000-0000-0000-0000-0000000fd1aa'),
  'line_product:pending:rule+ai1, sms_category:changed:ai1', 'the decided one stays decided; the other is refreshed');
select throws_ok($$insert into match_suggestion (household_id, task, target_key, proposal, confidence, pattern, input_hash, line_id)
  values ('00000000-0000-0000-0000-0000000fe1bb', 'line_product', 'x', '{}', 1, 'x', 'x', '00000000-0000-0000-0000-0000000fd0f1')$$,
  '23503', null, 'a suggestion can''t point at another household''s line');

-- ── Line actions ──────────────────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd102","role":"authenticated"}';
select lives_ok($$select rpc_line_link_product('00000000-0000-0000-0000-0000000fd0f1', '00000000-0000-0000-0000-0000000fd0d1')$$,
  'a member links an old line to its product');
select is((select (product_id is not null) || ' ' || destiny from transaction_line where id = '00000000-0000-0000-0000-0000000fd0f1'),
  'true stock', 'the line has its product');
select is((select count(*)::int from stock_lot where transaction_line_id = '00000000-0000-0000-0000-0000000fd0f1'), 0,
  'and no stock was invented');
select is((select destiny || ' ' || (product_id is not null) from product_alias where alias_norm = 'keeri smba 5kg'), 'stock true',
  'the bill name is learned');
select lives_ok($$select rpc_line_link_product('00000000-0000-0000-0000-0000000fd0f1', null, 'expense')$$, 'or: not pantry');
select is((select destiny from product_alias where alias_norm = 'keeri smba 5kg'), 'expense', 'learned as not pantry');
select throws_ok($$select rpc_line_link_product('00000000-0000-0000-0000-0000000fd0f1', '00000000-0000-0000-0000-0000000fe0d1')$$,
  '23503', null, 'another household''s product is refused');
select lives_ok($$select rpc_line_category('00000000-0000-0000-0000-0000000fd0f2', '00000000-0000-0000-0000-0000000fd0c3')$$,
  'a member moves "Delivery charge" out of "Other service"');
select is((select l.category_id = m.category_id from transaction_line l, line_memory m
            where l.id = '00000000-0000-0000-0000-0000000fd0f2' and m.name_norm = 'delivery charge'), true,
  'the category changed and the name was learned');
select throws_ok($$select rpc_line_category('00000000-0000-0000-0000-0000000fd0f2', '00000000-0000-0000-0000-0000000fe0c1')$$,
  '23503', null, 'another household''s category is refused');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd103","role":"authenticated"}';
select throws_ok($$select rpc_line_category('00000000-0000-0000-0000-0000000fd0f2', '00000000-0000-0000-0000-0000000fd0c1')$$,
  '42501', null, 'a viewer cannot change a line');
select throws_ok($$select rpc_match_decide(array(select id from match_suggestion where task = 'line_product'), 'accepted')$$,
  '42501', null, 'nor decide a suggestion');

-- ── Household B sees nothing of A ─────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fe101","role":"authenticated"}';
select is((select count(*)::int from match_suggestion where household_id = '00000000-0000-0000-0000-0000000fd1aa')
          + (select count(*)::int from match_run where household_id = '00000000-0000-0000-0000-0000000fd1aa')
          + (select count(*)::int from ai_usage where household_id = '00000000-0000-0000-0000-0000000fd1aa')
          + (select count(*)::int from match_eval where household_id = '00000000-0000-0000-0000-0000000fd1aa')
          + (select count(*)::int from match_setting where household_id = '00000000-0000-0000-0000-0000000fd1aa'), 0,
  'household B sees none of A''s matching tables');
select throws_ok($$select rpc_match_decide(array(select id from match_suggestion), 'accepted')$$, '42501', null,
  'and cannot decide anything of A''s');
select throws_ok($$select rpc_line_link_product('00000000-0000-0000-0000-0000000fd0f1', null, 'expense')$$, '42501', null,
  'or touch A''s lines');

select * from finish();
rollback;
