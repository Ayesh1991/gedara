-- Insights & Attention behaviour (Phase 6): recurring periods (month ends), pay / link / unlink /
-- skip and "deleting the payment makes it due again"; units → Rs per kWh; budgets carry over and
-- stop at 0; the activity timeline (transactions, one row per stock action); every attention kind
-- with its severity, hiding and "until it changes"; the push digest (token, idempotent, results);
-- ⌘K search; grouped spend; balances over time; velocity and stock flow.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(70);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create function pg_temp.today() returns date language sql stable as
  $$ select (now() at time zone 'Asia/Colombo')::date $$;
create function pg_temp.rule() returns public.v_recurring_due language sql stable as
  $$ select * from public.v_recurring_due where id = '00000000-0000-0000-0000-00000000f721' $$;
create function pg_temp.kinds() returns text language sql stable as
  $$ select string_agg(kind || '/' || severity || coalesce(':' || title, ''), ' ' order by kind, title)
       from public.attention_feed('00000000-0000-0000-0000-0000000f71aa') $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

-- ── Period arithmetic (pure) ──────────────────────────────────────────────────
select is(private.recurring_next('2026-01-31', 1, 'month', '2026-01-31'), '2026-02-28'::date,
  'monthly from 31 Jan: the next period is 28 Feb');
select is(private.recurring_next('2026-01-31', 1, 'month', '2026-02-28'), '2026-03-31'::date,
  '… and then 31 Mar again (counted from the first due date, no drift)');
select is(private.recurring_next('2026-01-10', 2, 'week', '2026-01-10'), '2026-01-24'::date, 'every 2 weeks');
select is(private.recurring_next('2026-01-10', 1, 'year', '2026-05-01'), '2027-01-10'::date, 'yearly');
select is(private.recurring_next('2026-01-10', 1, 'month', null), '2026-01-10'::date, 'nothing settled: first due');

-- ── Fixtures ──────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000f7101', 'insb-owner@test.local');
insert into household (id, name) values ('00000000-0000-0000-0000-0000000f71aa', 'InsB C');
insert into household_member (household_id, user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-0000000f7101', 'owner', 'Didula');
insert into category (id, household_id, key, name, kind, default_destiny) values
  ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-0000000f71aa', 'grocery', 'Grocery', 'expense', 'stock'),
  ('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-0000000f71aa', 'utilities', 'Utilities', 'expense', 'expense'),
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-0000000f71aa', 'income', 'Income', 'income', 'expense');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-00000000f702', '00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f701', 'Rice'),
  ('00000000-0000-0000-0000-00000000f704', '00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f703', 'Electricity'),
  ('00000000-0000-0000-0000-00000000f706', '00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f705', 'Salary');
insert into account (id, household_id, name, kind, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-00000000f711', '00000000-0000-0000-0000-0000000f71aa', 'Cash', 'cash', 5000, pg_temp.today() - 1);
insert into product (id, household_id, name, name_si, stock_unit_id, due_type, min_qty, category_id) values
  ('00000000-0000-0000-0000-00000000f731', '00000000-0000-0000-0000-0000000f71aa', 'Milk', 'කිරි', pg_temp.u('pcs'), 'expiry', null, null),
  ('00000000-0000-0000-0000-00000000f732', '00000000-0000-0000-0000-0000000f71aa', 'Keeri samba', null, pg_temp.u('g'), 'best_before', 5000,
   '00000000-0000-0000-0000-00000000f702'),
  ('00000000-0000-0000-0000-00000000f733', '00000000-0000-0000-0000-0000000f71aa', 'Yoghurt', null, pg_temp.u('pcs'), 'expiry', null, null);
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-00000000f741', '00000000-0000-0000-0000-0000000f71aa', 'expense',
   '00000000-0000-0000-0000-00000000f711', 'Keells', pg_temp.today(), 1500, 'minsc1');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f741', 0, 'KEERI SAMBA 5KG',
   '00000000-0000-0000-0000-00000000f702', 1500, 'minsc1-0-a');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7101","role":"authenticated"}';

-- ── Recurring: due, pay, units, GDRPP ─────────────────────────────────────────
insert into recurring_rule (id, household_id, name, category_id, account_id, expected_amount, first_due, usage_unit) values
  ('00000000-0000-0000-0000-00000000f721', '00000000-0000-0000-0000-0000000f71aa', ' CEB ',
   '00000000-0000-0000-0000-00000000f704', '00000000-0000-0000-0000-00000000f711', 1100, pg_temp.today() - 40, 'kWh');
select is((select name || ' ' || next_due || ' ' || days_left from pg_temp.rule()),
  'CEB ' || (pg_temp.today() - 40) || ' -40', 'a new bill is due on its first due date (name trimmed)');
select ok(pg_temp.kinds() like '%bill_due/red:CEB%', 'an overdue bill is red in Attention');

insert into t_c values ('pay1', rpc_recurring_pay(jsonb_build_object(
  'rule_id', '00000000-0000-0000-0000-00000000f721', 'units', 120,
  'transaction', jsonb_build_object('type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000f711',
    'payee_text', 'CEB', 'occurred_on', pg_temp.today(), 'total', 1200, 'fingerprint', 'minsceb1',
    'lines', jsonb_build_array(jsonb_build_object('line_no', 0, 'raw_name', 'Electricity',
      'category_id', '00000000-0000-0000-0000-00000000f704', 'amount', 1200, 'fingerprint', 'minsceb1-0-a'))))));
select is((select v ->> 'period' from t_c where k = 'pay1'), (pg_temp.today() - 40)::text, 'Pay settles the due period');
select is((select source || ' ' || recurring_period from money_transaction where fingerprint = 'minsceb1'),
  'recurring ' || (pg_temp.today() - 40), 'the expense is a recurring payment for that period');
select is((select next_due from pg_temp.rule()), (pg_temp.today() - 40 + interval '1 month')::date,
  'the next period is due next');
select is((select last_amount || ' ' || payments from pg_temp.rule()), '1200.00 1', 'last amount and count');
select is((select units || ' ' || per_unit from v_utility_usage where recurring_id = '00000000-0000-0000-0000-00000000f721'),
  '120.0000 10.00', 'units stored with the payment: Rs 10.00 per kWh');
select throws_ok($$select rpc_recurring_pay(jsonb_build_object('rule_id', '00000000-0000-0000-0000-00000000f721',
  'period', (select v ->> 'period' from t_c where k = 'pay1'),
  'transaction', jsonb_build_object('type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000f711',
    'occurred_on', pg_temp.today(), 'total', 1, 'fingerprint', 'minsceb9',
    'lines', jsonb_build_array(jsonb_build_object('raw_name', 'x', 'amount', 1, 'fingerprint', 'minsceb9-0-a')))))$$,
  'GDRPP', null, 'a period can''t be paid twice');
select throws_ok($$select rpc_recurring_pay(jsonb_build_object('rule_id', '00000000-0000-0000-0000-00000000f721',
  'transaction', jsonb_build_object('type', 'income', 'account_id', '00000000-0000-0000-0000-00000000f711',
    'occurred_on', pg_temp.today(), 'total', 1, 'fingerprint', 'minsceb8',
    'lines', jsonb_build_array(jsonb_build_object('raw_name', 'x', 'amount', 1, 'fingerprint', 'minsceb8-0-a')))))$$,
  '23514', null, 'an expense bill is paid with an expense');

-- ── Budgets: carry over, main categories only, budget vs actual ───────────────
select lives_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f701',
          (date_trunc('month', pg_temp.today()) - interval '2 months' + interval '16 days')::date, 1600)$$,
  'a Grocery budget from two months ago');
select is((select month from budget where category_id = '00000000-0000-0000-0000-00000000f701'),
  (date_trunc('month', pg_temp.today()) - interval '2 months')::date, 'stored as the first of its month');
select is((select budget || ' ' || budget_from || ' ' || spent from budget_month('00000000-0000-0000-0000-0000000f71aa', pg_temp.today())
            where category_id = '00000000-0000-0000-0000-00000000f701'),
  '1600.00 ' || (date_trunc('month', pg_temp.today()) - interval '2 months')::date || ' 1500.00',
  'it carries over to this month; Rs 1,500 spent');
select throws_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f702', current_date, 1)$$,
  '23514', null, 'sub-categories have no budget');
select throws_ok($$insert into budget (household_id, category_id, month, amount)
  values ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f705', current_date, 1)$$,
  '23514', null, 'income has no budget');
insert into budget (household_id, category_id, month, amount) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f703', pg_temp.today(), 1000);
select is((select budget || ' ' || spent from budget_month('00000000-0000-0000-0000-0000000f71aa', pg_temp.today())
            where category_id = '00000000-0000-0000-0000-00000000f703'),
  '1000.00 1200.00', 'Utilities: Rs 1,200 of Rs 1,000 (sub-category spending rolls up)');
select ok(pg_temp.kinds() like '%budget_over/red:Utilities%' and pg_temp.kinds() like '%budget_near/amber:Grocery%',
  'over budget is red, ≥ 90 % is amber');
insert into budget (household_id, category_id, month, amount) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f701', pg_temp.today() + 40, 0);
select is((select count(*)::int from budget_month('00000000-0000-0000-0000-0000000f71aa', pg_temp.today() + 40)
            where category_id = '00000000-0000-0000-0000-00000000f701'),
  0, 'an amount of 0 stops the budget from that month on');

-- ── Grouped spend, balances over time ─────────────────────────────────────────
select is((select string_agg(label || '=' || amount, ' ' order by label)
             from insights_spend('00000000-0000-0000-0000-0000000f71aa', '{"by":"top"}')),
  'Grocery=1500.00 Utilities=1200.00', 'spend by main category');
select is((select string_agg(label || '=' || amount || '/' || lines, ' ')
             from insights_spend('00000000-0000-0000-0000-0000000f71aa',
                                 '{"by":"category","cat":"00000000-0000-0000-0000-00000000f703"}')),
  'Electricity=1200.00/1', 'one level down: the sub-categories of Utilities');
select is((select string_agg(key || '=' || amount, ' ')
             from insights_spend('00000000-0000-0000-0000-0000000f71aa',
                                 '{"by":"item","sub":"00000000-0000-0000-0000-00000000f702"}')),
  'n:keeri samba 5kg=1500.00', 'lines without a product group by their printed name');
select is((select count(*)::int from insights_spend('00000000-0000-0000-0000-0000000f71aa',
                                 jsonb_build_object('by', 'top', 'from', pg_temp.today() + 1))), 0, 'the period filter');
select is((select count(*)::int from v_spend_line where household_id = '00000000-0000-0000-0000-0000000f71aa'
             and lower(raw_name) = 'keeri samba 5kg'), 1, 'the record level: the bill line itself');
select is((select balance from v_account_month_end where account_id = '00000000-0000-0000-0000-00000000f711'
             and month = date_trunc('month', pg_temp.today())::date),
  2300.00, 'Cash at the end of this month: 5000 − 1500 − 1200');
select is((select string_agg(verb, ',' order by id) from activity where entity_type = 'transaction'
             and entity_id = (select id from money_transaction where fingerprint = 'minsceb1')),
  'created', 'a new transaction is on the timeline');

-- ── Delete the payment: due again; skip; link / unlink ────────────────────────
select lives_ok($$select rpc_delete_transaction((select id from money_transaction where fingerprint = 'minsceb1'))$$,
  'the payment is deleted in Money');
select is((select next_due from pg_temp.rule()), pg_temp.today() - 40, '… so the bill is due again');
select is((select count(*)::int from meter_reading), 0, '… and its units went with it');
select is((select string_agg(verb, ',') from v_activity where entity_type = 'transaction'
             and entity_id = (select (v ->> 'id')::uuid from t_c where k = 'pay1')),
  'deleted', 'the timeline keeps one "deleted" entry');
insert into recurring_skip (household_id, rule_id, period) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-00000000f721', pg_temp.today() - 40);
select is((select next_due from pg_temp.rule()), (pg_temp.today() - 40 + interval '1 month')::date,
  'skipping a period moves on to the next one');
insert into t_c values ('tx2', rpc_save_transaction(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f71aa', 'type', 'expense',
  'account_id', '00000000-0000-0000-0000-00000000f711', 'payee_text', 'CEB SMS', 'occurred_on', pg_temp.today(),
  'total', 1000, 'fingerprint', 'minsceb2', 'lines', jsonb_build_array(jsonb_build_object(
    'line_no', 0, 'raw_name', 'Electricity', 'category_id', '00000000-0000-0000-0000-00000000f704',
    'amount', 1000, 'fingerprint', 'minsceb2-0-a')))));
select is(rpc_recurring_link('00000000-0000-0000-0000-00000000f721', (select (v ->> 'id')::uuid from t_c where k = 'tx2'),
                             null, 50),
  (pg_temp.today() - 40 + interval '1 month')::date, 'a bill already in Money pays the due period');
select is((select next_due from pg_temp.rule()), (pg_temp.today() - 40 + interval '2 months')::date, '… so the next is due');
select is((select per_unit from v_utility_usage where transaction_id = (select (v ->> 'id')::uuid from t_c where k = 'tx2')),
  20.00, 'linking can bring units too');
select lives_ok($$select rpc_recurring_unlink((select (v ->> 'id')::uuid from t_c where k = 'tx2'))$$, 'unlink');
select is((select next_due || ' ' || (select count(*) from meter_reading) from pg_temp.rule()),
  (pg_temp.today() - 40 + interval '1 month')::date || ' 0', 'unlinked: due again, units gone, the expense stays');
insert into recurring_rule (id, household_id, name, type, category_id, first_due) values
  ('00000000-0000-0000-0000-00000000f722', '00000000-0000-0000-0000-0000000f71aa', 'Salary', 'income',
   '00000000-0000-0000-0000-00000000f706', pg_temp.today() + 20);
select throws_ok($$select rpc_recurring_link('00000000-0000-0000-0000-00000000f722',
  (select (v ->> 'id')::uuid from t_c where k = 'tx2'))$$, '23503', null, 'an income rule can''t take an expense');

-- ── Stock: one timeline row per action; velocity; flow; pantry attention ──────
insert into t_c values ('m1', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'product_id', '00000000-0000-0000-0000-00000000f731', 'qty', 5, 'total_cost', 500, 'due_date', pg_temp.today() - 1)));
insert into t_c values ('m2', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'product_id', '00000000-0000-0000-0000-00000000f731', 'qty', 2, 'total_cost', 240, 'due_date', pg_temp.today() + 10)));
insert into t_c values ('use', rpc_consume(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'product_id', '00000000-0000-0000-0000-00000000f731', 'qty', 6)));
select is((select count(*)::int || ' ' || min(summary) || ' ' || min(payload ->> 'qty') || ' ' || min(payload ->> 'value')
             from activity where entity_type = 'stock' and verb = 'consume'
              and entity_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'use')),
  '1 Milk 6.0000 620.00', 'consuming from 2 lots is ONE timeline entry: Milk × 6, Rs 620');
select is((select count(*)::int from activity where entity_type = 'stock' and verb = 'purchase'
             and household_id = '00000000-0000-0000-0000-0000000f71aa'), 2, 'each purchase is one entry');
select is((select used_90 || ' ' || per_day || ' ' || days_to_empty from v_product_velocity
            where product_id = '00000000-0000-0000-0000-00000000f731'),
  '6.0000 0.4286 2', 'velocity: 6 used ÷ 14 days minimum window; 1 left = 2 days');
select is((select string_agg(flow || '=' || qty || '/' || value, ' ' order by flow) from v_stock_flow_month
            where product_id = '00000000-0000-0000-0000-00000000f731'),
  'bought=7.0000/740.00 consumed=6.0000/620.00', 'stock flow: bought vs consumed (qty and Rs)');
insert into t_c values ('y', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'product_id', '00000000-0000-0000-0000-00000000f733', 'qty', 1, 'total_cost', 150, 'due_date', pg_temp.today() - 1)));
insert into t_c values ('r', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'product_id', '00000000-0000-0000-0000-00000000f732', 'qty', 1000, 'total_cost', 300, 'due_date', pg_temp.today() + 3)));
select ok(pg_temp.kinds() like '%expired/red:Yoghurt%', 'past its expiry date: red');
select ok(pg_temp.kinds() like '%due_soon/cyan:Keeri samba%', 'due within 5 days: cyan');
select ok(pg_temp.kinds() like '%below_min/violet:Keeri samba%', 'below its minimum: violet');
select ok(pg_temp.kinds() like '%runs_out/violet:Milk%', 'Milk runs out in 2 days at this rate');

-- ── Things: warranty and service ──────────────────────────────────────────────
insert into asset (id, household_id, name, warranty_until) values
  ('00000000-0000-0000-0000-00000000f751', '00000000-0000-0000-0000-0000000f71aa', 'Fridge', pg_temp.today() + 10);
insert into maintenance_plan (id, household_id, asset_id, name, every_days, next_due) values
  ('00000000-0000-0000-0000-00000000f752', '00000000-0000-0000-0000-0000000f71aa',
   '00000000-0000-0000-0000-00000000f751', 'Defrost', 30, pg_temp.today() - 2);
select ok(pg_temp.kinds() like '%warranty_ending/cyan:Fridge%', 'a warranty ending within 30 days');
select ok(pg_temp.kinds() like '%service_due/amber:Fridge%', 'an overdue service is amber');
select is((select severity from attention_feed('00000000-0000-0000-0000-0000000f71aa') limit 1), 'red',
  'the most urgent comes first');

-- ── Hiding: for a while, or until it changes ──────────────────────────────────
insert into attention_dismissal (household_id, item_key)
  select '00000000-0000-0000-0000-0000000f71aa', item_key from attention_feed('00000000-0000-0000-0000-0000000f71aa')
   where kind = 'service_due';
select ok(pg_temp.kinds() not like '%service_due%', 'hidden until it changes');
update maintenance_plan set next_due = pg_temp.today() - 1 where id = '00000000-0000-0000-0000-00000000f752';
select ok(pg_temp.kinds() like '%service_due%', 'a new due date is a new item: it shows again');
insert into attention_dismissal (household_id, item_key, hidden_until)
  select '00000000-0000-0000-0000-0000000f71aa', item_key, pg_temp.today() + 1
    from attention_feed('00000000-0000-0000-0000-0000000f71aa') where kind = 'warranty_ending';
select ok(pg_temp.kinds() not like '%warranty_ending%', 'hidden until tomorrow');
update attention_dismissal set hidden_until = pg_temp.today() where item_key like 'warranty:%';
select ok(pg_temp.kinds() like '%warranty_ending%', '… and back when that day comes');

-- ── Search ────────────────────────────────────────────────────────────────────
select is((select type || ':' || title from search_all('00000000-0000-0000-0000-0000000f71aa', 'කිරි') limit 1),
  'product:Milk', 'a product by its Sinhala name');
select is((select string_agg(type || ':' || title, ' ' order by type)
             from search_all('00000000-0000-0000-0000-0000000f71aa', 'samba')),
  'line:KEERI SAMBA 5KG product:Keeri samba', 'a bill line as printed, and the product');
select is((select ref_id from search_all('00000000-0000-0000-0000-0000000f71aa', 'samba') where type = 'line'),
  '00000000-0000-0000-0000-00000000f741'::uuid, 'a line opens its bill');
select is((select count(*)::int from search_all('00000000-0000-0000-0000-0000000f71aa', '%')), 0,
  'wildcards are literal');
select is((select type from search_all('00000000-0000-0000-0000-0000000f71aa', 'Frige') limit 1), 'asset',
  'a typo still finds the Fridge');

-- ── Push digest ───────────────────────────────────────────────────────────────
select isnt(rpc_push_subscribe(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'endpoint', 'https://push.example/c1', 'p256dh', repeat('C', 87), 'auth', repeat('c', 22))), null, 'a device subscribes');
select lives_ok($$select rpc_push_subscribe(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f71aa',
  'endpoint', 'https://push.example/c2', 'p256dh', repeat('D', 87), 'auth', repeat('d', 22)))$$, 'and another');
reset role;
insert into t_c values ('token', to_jsonb(private.cron_token()));
select ok((select length(v #>> '{}') from t_c where k = 'token') = 64, 'the migration made a 32-byte cron token in Vault');
set local role service_role;
select throws_ok($$select rpc_push_digest('wrong')$$, '42501', null, 'a wrong token starts nothing');
insert into t_c values ('digest', rpc_push_digest((select v #>> '{}' from t_c where k = 'token')));
insert into t_c select 'run', r from jsonb_array_elements((select v -> 'runs' from t_c where k = 'digest')) r
  where r ->> 'household_id' = '00000000-0000-0000-0000-0000000f71aa';
select is((select jsonb_array_length(v -> 'items') || ' ' || jsonb_array_length(v -> 'subscriptions') || ' '
                  || (v #>> '{items,0,severity}') from t_c where k = 'run'),
  '5 2 red', 'the digest: the top 5 items, both devices, most urgent first');
select ok((select (v ->> 'total')::int > 5 from t_c where k = 'run'), '… with the full count');
select is((select count(*)::int from jsonb_array_elements((rpc_push_digest((select v #>> '{}' from t_c where k = 'token'))) -> 'runs') r
            where r ->> 'household_id' = '00000000-0000-0000-0000-0000000f71aa'),
  0, 'once a day: a second run today sends nothing');
select lives_ok($$select rpc_push_result((select v #>> '{}' from t_c where k = 'token'), (select (v ->> 'run_id')::uuid from t_c where k = 'run'),
  jsonb_build_array(
    jsonb_build_object('id', (select v #>> '{subscriptions,0,id}' from t_c where k = 'run'), 'ok', true),
    jsonb_build_object('id', (select v #>> '{subscriptions,1,id}' from t_c where k = 'run'), 'ok', false, 'status', 410)))$$,
  'results are reported');
reset role;
select is((select count(*)::int || ' ' || bool_and(last_ok_at is not null) from push_subscription
            where household_id = '00000000-0000-0000-0000-0000000f71aa'),
  '1 true', 'the delivered device is marked ok; the gone one (410) is removed');
select is((select sent || '/' || failed || ' ' || (finished_at is not null) from push_run
            where id = (select (v ->> 'run_id')::uuid from t_c where k = 'run')),
  '1/1 true', 'the run records what happened');

select * from finish();
rollback;
