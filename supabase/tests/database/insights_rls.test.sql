-- Insights & Attention (Phase 6): household isolation for recurring_rule, recurring_skip,
-- meter_reading, budget, attention_dismissal, push_subscription, push_run, every new view and
-- function; viewers read-only; push rows private to their owner; the push RPCs service_role only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(47);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f6101', 'ins-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6103', 'ins-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6201', 'ins-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f61aa', 'Ins A'),
  ('00000000-0000-0000-0000-0000000f62bb', 'Ins B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-0000000f6101', 'owner'),
  ('00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-0000000f6103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-0000000f6201', 'owner');
insert into category (id, household_id, key, name) values
  ('00000000-0000-0000-0000-00000000f611', '00000000-0000-0000-0000-0000000f61aa', 'utilities', 'Utilities'),
  ('00000000-0000-0000-0000-00000000f6b1', '00000000-0000-0000-0000-0000000f62bb', 'utilities', 'Utilities');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-00000000f612', '00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-00000000f611', 'Electricity'),
  ('00000000-0000-0000-0000-00000000f6b2', '00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6b1', 'Electricity');
insert into account (id, household_id, name, kind, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-00000000f621', '00000000-0000-0000-0000-0000000f61aa', 'Cash A', 'cash', 0, '2026-01-01'),
  ('00000000-0000-0000-0000-00000000f6c1', '00000000-0000-0000-0000-0000000f62bb', 'Cash B', 'cash', 1000, '2026-01-01');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000f6d1', '00000000-0000-0000-0000-0000000f62bb', 'Room B');
insert into recurring_rule (id, household_id, name, category_id, account_id, first_due, usage_unit) values
  ('00000000-0000-0000-0000-00000000f631', '00000000-0000-0000-0000-0000000f61aa', 'CEB A',
   '00000000-0000-0000-0000-00000000f612', '00000000-0000-0000-0000-00000000f621', '2026-01-10', 'kWh'),
  ('00000000-0000-0000-0000-00000000f6e1', '00000000-0000-0000-0000-0000000f62bb', 'CEB B',
   '00000000-0000-0000-0000-00000000f6b2', '00000000-0000-0000-0000-00000000f6c1', '2026-01-10', 'kWh');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint,
                               recurring_id, recurring_period) values
  ('00000000-0000-0000-0000-00000000f6f1', '00000000-0000-0000-0000-0000000f62bb', 'expense',
   '00000000-0000-0000-0000-00000000f6c1', 'CEB', '2026-01-12', 900, 'minsb1',
   '00000000-0000-0000-0000-00000000f6e1', '2026-01-10');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6f1', 0, 'Electricity',
   '00000000-0000-0000-0000-00000000f6b2', 900, 'minsb1-0-a');
insert into meter_reading (household_id, recurring_id, transaction_id, read_on, units) values
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6e1',
   '00000000-0000-0000-0000-00000000f6f1', '2026-01-12', 90);
insert into recurring_skip (household_id, rule_id, period) values
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6e1', '2026-02-10');
insert into budget (household_id, category_id, month, amount) values
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6b1', '2026-01-01', 800);
insert into attention_dismissal (household_id, item_key) values
  ('00000000-0000-0000-0000-0000000f62bb', 'bill:x:2026-01-10');
insert into push_subscription (household_id, user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-0000000f6201', 'https://push.example/b1',
   repeat('B', 87), repeat('b', 22));
insert into push_run (household_id, run_on, items) values ('00000000-0000-0000-0000-0000000f62bb', '2026-01-10', 1);

select ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and c.relname in ('v_recurring_due', 'v_activity', 'v_spend_line', 'v_account_month_end', 'v_product_price_month',
                       'v_stock_flow_month', 'v_product_velocity', 'v_utility_usage', 'v_location_contents')
     and not coalesce(c.reloptions @> array['security_invoker=true'], false)),
  'every new view runs with the caller''s RLS (security_invoker)');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6101","role":"authenticated"}';

select is((select count(*)::int from recurring_rule), 1, 'owner sees A''s recurring bills only');
select lives_ok($$insert into recurring_rule (household_id, name, first_due)
  values ('00000000-0000-0000-0000-0000000f61aa', 'Water A', '2026-01-05')$$, 'owner adds a recurring bill');
select throws_ok($$insert into recurring_rule (household_id, name, first_due)
  values ('00000000-0000-0000-0000-0000000f62bb', 'Sneaky', '2026-01-05')$$, '42501', null, 'not into B');
select throws_ok($$insert into recurring_rule (household_id, name, first_due, account_id)
  values ('00000000-0000-0000-0000-0000000f61aa', 'Cross', '2026-01-05', '00000000-0000-0000-0000-00000000f6c1')$$,
  '23503', null, 'a bill can''t use B''s account');
update recurring_rule set name = 'Hacked' where id = '00000000-0000-0000-0000-00000000f6e1';
delete from recurring_rule where id = '00000000-0000-0000-0000-00000000f6e1';
select is((select count(*)::int from v_recurring_due), 2, 'v_recurring_due shows A''s bills only');

select is((select count(*)::int from recurring_skip), 0, 'B''s skipped periods are invisible');
select throws_ok($$insert into recurring_skip (household_id, rule_id, period)
  values ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6e1', '2026-03-10')$$,
  '42501', null, 'can''t skip B''s bill');
select is((select count(*)::int from meter_reading), 0, 'B''s meter readings are invisible');
select throws_ok($$insert into meter_reading (household_id, recurring_id, read_on, units)
  values ('00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-00000000f631', '2026-01-10', 5)$$,
  '42501', null, 'meter readings are written by the pay/link RPCs only');
update meter_reading set units = 1;

select throws_ok($$select rpc_recurring_pay(jsonb_build_object('rule_id', '00000000-0000-0000-0000-00000000f6e1',
  'transaction', jsonb_build_object('type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000f6c1',
  'occurred_on', '2026-03-01', 'total', 1, 'fingerprint', 'mhack', 'lines', jsonb_build_array(jsonb_build_object(
  'raw_name', 'x', 'amount', 1, 'fingerprint', 'mhack-0-a')))))$$, '42501', null, 'can''t pay B''s bill');
select throws_ok($$select rpc_recurring_link('00000000-0000-0000-0000-00000000f6e1', '00000000-0000-0000-0000-00000000f6f1')$$,
  '42501', null, 'can''t link B''s bill');
select throws_ok($$select rpc_recurring_link('00000000-0000-0000-0000-00000000f631', '00000000-0000-0000-0000-00000000f6f1')$$,
  '23503', null, 'can''t link B''s transaction to A''s bill');
select throws_ok($$select rpc_recurring_unlink('00000000-0000-0000-0000-00000000f6f1')$$,
  '42501', null, 'can''t unlink B''s payment');

select lives_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-00000000f611', '2026-01-01', 500)$$,
  'owner sets a budget');
select throws_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f62bb', '00000000-0000-0000-0000-00000000f6b1', '2026-02-01', 1)$$,
  '42501', null, 'not in B');
select is((select count(*)::int from budget), 1, 'owner sees A''s budgets only');
update budget set amount = 1 where household_id = '00000000-0000-0000-0000-0000000f62bb';

select lives_ok($$insert into attention_dismissal (household_id, item_key)
  values ('00000000-0000-0000-0000-0000000f61aa', 'bill:a:2026-01-10')$$, 'owner hides an attention item');
select throws_ok($$insert into attention_dismissal (household_id, item_key)
  values ('00000000-0000-0000-0000-0000000f62bb', 'bill:b:2026-01-10')$$, '42501', null, 'not for B');
select is((select count(*)::int from attention_dismissal), 1, 'owner sees A''s hidden items only');

select isnt(rpc_push_subscribe(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f61aa',
  'endpoint', 'https://push.example/a1', 'p256dh', repeat('A', 87), 'auth', repeat('a', 22), 'label', 'Phone')),
  null, 'owner turns on notifications on a device');
select throws_ok($$select rpc_push_subscribe(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f62bb',
  'endpoint', 'https://push.example/a2', 'p256dh', repeat('A', 87), 'auth', repeat('a', 22)))$$,
  '42501', null, 'can''t subscribe to B''s household');
select throws_ok($$insert into push_subscription (household_id, endpoint, p256dh, auth)
  values ('00000000-0000-0000-0000-0000000f61aa', 'https://push.example/a3', repeat('A', 87), repeat('a', 22))$$,
  '42501', null, 'subscriptions are written by rpc_push_subscribe only');
select is((select count(*)::int from push_subscription), 1, 'owner sees own devices only');
update push_subscription set enabled = false where endpoint = 'https://push.example/b1';
select is((select count(*)::int from push_run), 0, 'B''s push runs are invisible');
select throws_ok($$select rpc_push_digest('x')$$, '42501', null, 'signed-in users can''t start a push run');
select throws_ok($$select rpc_push_result('x', null, '[]')$$, '42501', null, '… or report one');
select throws_ok($$select attention_push_status('00000000-0000-0000-0000-0000000f62bb')$$, '42501', null,
  'push status of B is refused');

select is((select count(*)::int from attention_feed('00000000-0000-0000-0000-0000000f62bb')), 0,
  'attention_feed(B) returns nothing');
select is((select count(*)::int from budget_month('00000000-0000-0000-0000-0000000f62bb', '2026-01-01')), 0,
  'budget_month(B) returns nothing');
select is((select count(*)::int from insights_spend('00000000-0000-0000-0000-0000000f62bb', '{"by":"top"}')), 0,
  'insights_spend(B) returns nothing');
select is((select count(*)::int from search_all('00000000-0000-0000-0000-0000000f62bb', 'CEB')), 0,
  'search_all(B) returns nothing');
select is((select count(*)::int from v_spend_line where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_account_month_end where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_utility_usage where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_location_contents where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_activity where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_product_price_month where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_stock_flow_month where household_id = '00000000-0000-0000-0000-0000000f62bb')
        + (select count(*)::int from v_product_velocity where household_id = '00000000-0000-0000-0000-0000000f62bb'),
  0, 'no Insights view shows B''s rows');
select ok((select count(*)::int from v_account_month_end where household_id = '00000000-0000-0000-0000-0000000f61aa') > 0,
  '… while A''s own balances over time are there');

-- ── Viewer of A: reads, never writes ──────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6103","role":"authenticated"}';

select is((select count(*)::int from recurring_rule), 2, 'viewer reads A''s recurring bills');
select throws_ok($$insert into recurring_rule (household_id, name, first_due)
  values ('00000000-0000-0000-0000-0000000f61aa', 'Viewer', '2026-01-05')$$, '42501', null, 'viewer can''t add one');
select throws_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f61aa', '00000000-0000-0000-0000-00000000f611', '2026-02-01', 1)$$,
  '42501', null, 'viewer can''t set budgets');
select throws_ok($$insert into attention_dismissal (household_id, item_key)
  values ('00000000-0000-0000-0000-0000000f61aa', 'bill:v:2026-01-10')$$, '42501', null, 'viewer can''t hide items');
select throws_ok($$select rpc_recurring_link('00000000-0000-0000-0000-00000000f631', '00000000-0000-0000-0000-00000000f6f1')$$,
  '42501', null, 'viewer can''t link payments');
select is((select count(*)::int from push_subscription), 0, 'viewer doesn''t see the owner''s devices');
select lives_ok($$select rpc_push_subscribe(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f61aa',
  'endpoint', 'https://push.example/a1', 'p256dh', repeat('A', 87), 'auth', repeat('a', 22)))$$,
  'a viewer gets notifications too (a shared iPad moves to them)');
select is((select count(*)::int from push_subscription), 1, 'the device is now the viewer''s');
select ok((select count(*)::int from attention_feed('00000000-0000-0000-0000-0000000f61aa')) >= 0,
  'viewer can read A''s attention feed');

-- ── Checks as superuser ───────────────────────────────────────────────────────
reset role;
select is((select name from recurring_rule where id = '00000000-0000-0000-0000-00000000f6e1'), 'CEB B',
  'B''s bill is unchanged and not deleted');
select is((select units from meter_reading where transaction_id = '00000000-0000-0000-0000-00000000f6f1'), 90.0000,
  'B''s meter reading is unchanged');
select is((select amount from budget where household_id = '00000000-0000-0000-0000-0000000f62bb'), 800.00,
  'B''s budget is unchanged');
select ok((select enabled from push_subscription where endpoint = 'https://push.example/b1'),
  'B''s device is still enabled');

select * from finish();
rollback;
