-- Things behaviour (Phase 5): the category data migration; "bought, not entered yet"; a thing from a
-- bill line (defaults, GDLIN, other household); bill edits / re-routing refused while a line has a
-- thing (GDRTD), deleting the bill keeps the thing; parts can't loop; maintenance → ledger expense
-- (create / link / delete, next due date follows); sell → income, GDSLD guards, unsell and deleting
-- the income bring it back; split; lend / return / move on the timeline; A-numbers never reused;
-- value, depreciation and cost of ownership in v_asset.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create function pg_temp.line(p_fp text) returns uuid language sql stable as
  $$ select id from public.transaction_line where fingerprint = p_fp $$;
create function pg_temp.tx(p_fp text) returns uuid language sql stable as
  $$ select id from public.money_transaction where fingerprint = p_fp $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

-- ── Migration 38 on the real households (read as superuser) ───────────────────
select is((select count(*)::int from category c join category p on p.id = c.parent_id and p.key = 'nonconsumable'
            where lower(c.name) in ('clothing', 'footwear', 'gifts') and c.default_destiny <> 'expense'),
  0, 'clothing, footwear and gifts are expense-only everywhere');
select is((select count(*)::int from category p where p.key = 'income'
            and not exists (select 1 from category s where s.parent_id = p.id and s.name = 'Sale of belongings')),
  0, 'every household with Income has "Sale of belongings"');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fd101', 'thg-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fd201', 'thg-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fd1aa', 'Thg A'),
  ('00000000-0000-0000-0000-0000000fd2bb', 'Thg B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd101', 'owner'),
  ('00000000-0000-0000-0000-0000000fd2bb', '00000000-0000-0000-0000-0000000fd201', 'owner');
insert into category (id, household_id, key, name, kind, default_destiny) values
  ('00000000-0000-0000-0000-00000000ed01', '00000000-0000-0000-0000-0000000fd1aa', 'nonconsumable', 'Non-consumables', 'expense', 'asset'),
  ('00000000-0000-0000-0000-00000000ed04', '00000000-0000-0000-0000-0000000fd1aa', 'services', 'Services', 'expense', 'expense'),
  ('00000000-0000-0000-0000-00000000ed06', '00000000-0000-0000-0000-0000000fd1aa', 'income', 'Income', 'income', 'expense'),
  ('00000000-0000-0000-0000-00000000ed07', '00000000-0000-0000-0000-0000000fd1aa', 'grocery', 'Grocery', 'expense', 'stock');
insert into category (id, household_id, parent_id, name, kind, default_destiny) values
  ('00000000-0000-0000-0000-00000000ed02', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-00000000ed01', 'Electronics', 'expense', 'asset'),
  ('00000000-0000-0000-0000-00000000ed03', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-00000000ed01', 'Clothing', 'expense', 'asset'),
  ('00000000-0000-0000-0000-00000000ed05', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-00000000ed04', 'Repairs & maintenance', 'expense', 'expense'),
  ('00000000-0000-0000-0000-00000000ed08', '00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-00000000ed06', 'Sale of belongings', 'income', 'expense');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000bd01', '00000000-0000-0000-0000-0000000fd1aa', 'Cash', 'cash'),
  ('00000000-0000-0000-0000-00000000bdb1', '00000000-0000-0000-0000-0000000fd2bb', 'Cash B', 'cash');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000cd01', '00000000-0000-0000-0000-0000000fd1aa', 'Kitchen'),
  ('00000000-0000-0000-0000-00000000cd02', '00000000-0000-0000-0000-0000000fd1aa', 'Bedroom');
insert into money_transaction (id, household_id, type, account_id, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-00000000dbb1', '00000000-0000-0000-0000-0000000fd2bb', 'expense',
   '00000000-0000-0000-0000-00000000bdb1', '2026-09-01', 100, 'mthgb1');
insert into transaction_line (id, household_id, transaction_id, line_no, raw_name, amount, destiny, fingerprint) values
  ('00000000-0000-0000-0000-00000000dbb2', '00000000-0000-0000-0000-0000000fd2bb', '00000000-0000-0000-0000-00000000dbb1', 0, 'Lamp', 100, 'asset', 'mthgb1-0-a');
insert into tag (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000fe01', '00000000-0000-0000-0000-0000000fd1aa', 'Dining');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';

-- ── A bill with things on it ──────────────────────────────────────────────────
insert into t_c values ('bill', rpc_import_bills('00000000-0000-0000-0000-0000000fd1aa', '[{
  "account_id":"00000000-0000-0000-0000-00000000bd01","payee_text":"Singer","occurred_on":"2026-09-01",
  "total":250000,"source":"scan","fingerprint":"bthg1",
  "lines":[
    {"line_no":0,"raw_name":"Samsung TV 55","category_id":"00000000-0000-0000-0000-00000000ed02","qty":1,"amount":200000,
     "fingerprint":"bthg1-0-a","route":{"destiny":"asset","learn":false}},
    {"line_no":1,"raw_name":"HDMI cable","category_id":"00000000-0000-0000-0000-00000000ed02","qty":2,"amount":3000,
     "fingerprint":"bthg1-1-b","route":{"destiny":"asset","learn":false}},
    {"line_no":2,"raw_name":"Rice","category_id":"00000000-0000-0000-0000-00000000ed07","amount":1000,
     "fingerprint":"bthg1-2-c"},
    {"line_no":3,"raw_name":"T-shirt","category_id":"00000000-0000-0000-0000-00000000ed03","amount":46000,
     "fingerprint":"bthg1-3-d","route":{"destiny":"asset","learn":false}}
  ]}]'));

select is((select string_agg(raw_name || '=' || amount::int, ', ' order by line_no) from v_asset_pending_line),
  'Samsung TV 55=200000, HDMI cable=3000, T-shirt=46000', 'bought, not entered yet: the bill''s Things lines');

select lives_ok($$insert into asset (id, household_id, name, location_id, transaction_line_id, warranty_until, useful_life_months)
  values ('00000000-0000-0000-0000-00000000ad01', '00000000-0000-0000-0000-0000000fd1aa', 'TV',
          '00000000-0000-0000-0000-00000000cd01', pg_temp.line('bthg1-0-a'), '2028-09-01', 60)$$,
  'a thing is entered from its bill line');
select is((select purchased_on || ' ' || vendor || ' ' || purchase_price || ' ' || asset_no from asset
            where id = '00000000-0000-0000-0000-00000000ad01'),
  '2026-09-01 Singer 200000.00 1', 'date, shop and price come from the bill');
select lives_ok($$insert into asset (id, household_id, name, transaction_line_id)
  values ('00000000-0000-0000-0000-00000000ad02', '00000000-0000-0000-0000-0000000fd1aa', 'HDMI cable',
          pg_temp.line('bthg1-1-b'))$$, 'one of two cables is entered');
select is((select purchase_price from asset where id = '00000000-0000-0000-0000-00000000ad02'), 1500.00::numeric(14,2),
  'its price is the line amount ÷ the line quantity');
select is((select count(*)::int from v_asset_pending_line), 1, 'entered lines leave the queue');
select throws_ok($$insert into asset (household_id, name, transaction_line_id)
  values ('00000000-0000-0000-0000-0000000fd1aa', 'Rice?', pg_temp.line('bthg1-2-c'))$$,
  'GDLIN', null, 'a non-Things line can''t buy a thing');
select throws_ok($$insert into asset (household_id, name, transaction_line_id)
  values ('00000000-0000-0000-0000-0000000fd1aa', 'Lamp', '00000000-0000-0000-0000-00000000dbb2')$$,
  '23503', null, 'a thing can''t point at another household''s bill');

-- The bill is protected while its lines have things
select throws_ok($$select rpc_save_transaction(jsonb_build_object(
    'id', pg_temp.tx('bthg1'), 'household_id', '00000000-0000-0000-0000-0000000fd1aa', 'type', 'expense',
    'account_id', '00000000-0000-0000-0000-00000000bd01', 'occurred_on', '2026-09-01', 'total', 250000,
    'lines', jsonb_build_array(jsonb_build_object('raw_name', 'All', 'category_id', '00000000-0000-0000-0000-00000000ed02',
                                                  'amount', 250000, 'fingerprint', 'bthg1-0-z'))))$$,
  'GDRTD', null, 'rewriting the lines of a bill that bought things is refused');
select lives_ok($$select rpc_save_transaction(jsonb_build_object(
    'id', pg_temp.tx('bthg1'), 'household_id', '00000000-0000-0000-0000-0000000fd1aa', 'type', 'expense',
    'account_id', '00000000-0000-0000-0000-00000000bd01', 'occurred_on', '2026-09-01', 'total', 250000,
    'payee_text', 'Singer Mega', 'keep_lines', true))$$, 'the header can still be edited (keep_lines)');
select throws_ok($$select rpc_route_lines(pg_temp.tx('bthg1'),
    jsonb_build_array(jsonb_build_object('line_id', pg_temp.line('bthg1-0-a'), 'destiny', 'expense')))$$,
  'GDRTD', null, 'a line with a thing can''t be re-routed');
select lives_ok($$select rpc_route_lines(pg_temp.tx('bthg1'),
    jsonb_build_array(jsonb_build_object('line_id', pg_temp.line('bthg1-3-d'), 'destiny', 'expense', 'learn', false)))$$,
  '"Not a thing" moves a line to expense only');
select is((select count(*)::int from v_asset_pending_line), 0, 'and it leaves the queue');

-- Parts
select lives_ok($$update asset set parent_id = '00000000-0000-0000-0000-00000000ad01'
  where id = '00000000-0000-0000-0000-00000000ad02'$$, 'the cable becomes a part of the TV');
select throws_ok($$update asset set parent_id = '00000000-0000-0000-0000-00000000ad02'
  where id = '00000000-0000-0000-0000-00000000ad01'$$, '23514', null, 'a thing can''t be a part of its own part');

-- ── Maintenance → ledger ──────────────────────────────────────────────────────
insert into maintenance_plan (id, household_id, asset_id, name, category_id, every_days)
values ('00000000-0000-0000-0000-00000000af01', '00000000-0000-0000-0000-0000000fd1aa',
        '00000000-0000-0000-0000-00000000ad01', 'Service', '00000000-0000-0000-0000-00000000ed05', 180);

insert into t_c values ('log1', rpc_log_maintenance('{
  "asset_id":"00000000-0000-0000-0000-00000000ad01","plan_id":"00000000-0000-0000-0000-00000000af01",
  "done_on":"2026-09-20","title":"Service","vendor":"Abans","cost":4500,
  "expense":{"account_id":"00000000-0000-0000-0000-00000000bd01","category_id":"00000000-0000-0000-0000-00000000ed05",
             "fingerprint":"mthg1","line_fingerprint":"mthg1-0-x"}}'));
select is((select t.type || ' ' || t.total || ' ' || t.payee_text || ' ' || t.occurred_on || ' ' || l.raw_name || ' '
                  || (l.category_id = '00000000-0000-0000-0000-00000000ed05')
             from money_transaction t join transaction_line l on l.transaction_id = t.id where t.fingerprint = 'mthg1'),
  'expense 4500.00 Abans 2026-09-20 TV — Service true', 'a service with a cost is an expense in the ledger');
select is((select (g.transaction_id = pg_temp.tx('mthg1')) || ' ' || g.created_expense || ' ' || g.cost
             from maintenance_log g where g.id = (select (v ->> 'id')::uuid from t_c where k = 'log1')),
  'true true 4500.00', 'the log links its expense');
select is((select next_due from maintenance_plan where id = '00000000-0000-0000-0000-00000000af01'), '2027-03-19'::date,
  'the plan is next due 180 days after the service');

select lives_ok($$select rpc_save_transaction('{"household_id":"00000000-0000-0000-0000-0000000fd1aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000bd01","occurred_on":"2026-09-22","payee_text":"Tech","total":3000,
  "fingerprint":"mthg3","lines":[{"raw_name":"AC gas","category_id":"00000000-0000-0000-0000-00000000ed05",
  "amount":3000,"fingerprint":"mthg3-0-a"}]}')$$, 'a technician''s bill arrives by itself (e.g. SMS)');
insert into t_c values ('log2', rpc_log_maintenance(jsonb_build_object(
  'asset_id', '00000000-0000-0000-0000-00000000ad01', 'plan_id', '00000000-0000-0000-0000-00000000af01',
  'done_on', '2026-09-22', 'title', 'Gas top-up', 'link_transaction_id', pg_temp.tx('mthg3'))));
select is((select g.cost || ' ' || g.created_expense || ' ' || (g.transaction_id = pg_temp.tx('mthg3'))
             from maintenance_log g where g.id = (select (v ->> 'id')::uuid from t_c where k = 'log2')),
  '3000.00 false true', 'linking an existing expense: cost from its total, nothing new in the ledger');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000fd1aa'),
  3, 'still three transactions (bill, service, technician)');
select is((select next_due from maintenance_plan where id = '00000000-0000-0000-0000-00000000af01'), '2027-03-21'::date,
  'next due follows the latest log');
select throws_ok($$select rpc_log_maintenance(jsonb_build_object('asset_id', '00000000-0000-0000-0000-00000000ad01',
  'title', 'x', 'cost', 1, 'link_transaction_id', pg_temp.tx('mthg3'),
  'expense', jsonb_build_object('account_id', '00000000-0000-0000-0000-00000000bd01')))$$,
  '23514', null, 'create an expense or link one, not both');
select throws_ok($$select rpc_log_maintenance('{"asset_id":"00000000-0000-0000-0000-00000000ad01","title":"x","cost":0,
  "expense":{"account_id":"00000000-0000-0000-0000-00000000bd01","category_id":"00000000-0000-0000-0000-00000000ed05",
             "fingerprint":"mthg9","line_fingerprint":"mthg9-0-x"}}')$$,
  '23514', null, 'an expense needs a cost');
select throws_ok($$select rpc_log_maintenance(jsonb_build_object('asset_id', '00000000-0000-0000-0000-00000000ad01',
  'title', 'x', 'link_transaction_id', '00000000-0000-0000-0000-00000000dbb1'))$$,
  '23503', null, 'B''s expense can''t be linked');
select is((select maintenance_cost || ' ' || cost_of_ownership || ' ' || last_maintained_on || ' ' || next_due
             from v_asset where id = '00000000-0000-0000-0000-00000000ad01'),
  '7500.00 207500.00 2026-09-22 2027-03-21', 'the TV''s cost of ownership includes its maintenance');

update maintenance_plan set every_days = 90 where id = '00000000-0000-0000-0000-00000000af01';
select is((select next_due from maintenance_plan where id = '00000000-0000-0000-0000-00000000af01'), '2026-12-21'::date,
  'a new interval moves the due date from the last service');
select lives_ok($$select rpc_delete_maintenance_log((select (v ->> 'id')::uuid from t_c where k = 'log2'), true)$$,
  'deleting the linked log');
select is((select count(*)::int from money_transaction where fingerprint = 'mthg3') || ' '
          || (select next_due from maintenance_plan where id = '00000000-0000-0000-0000-00000000af01'),
  '1 2026-12-19', '…keeps the expense it only linked; due date back to the previous service');
select lives_ok($$select rpc_delete_maintenance_log((select (v ->> 'id')::uuid from t_c where k = 'log1'), true)$$,
  'deleting the log that made its expense, with the expense');
select is((select count(*)::int from money_transaction where fingerprint = 'mthg1') || ' '
          || (select next_due from maintenance_plan where id = '00000000-0000-0000-0000-00000000af01'),
  '0 2026-12-19', '…removes that expense; the due date stays when no log is left');

-- ── Sell / unsell ─────────────────────────────────────────────────────────────
insert into asset (id, household_id, name, purchase_price, purchased_on, useful_life_months, salvage_value) values
  ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-0000000fd1aa', 'Fridge', 120000, '2010-01-15', 60, 20000);
insert into asset (id, household_id, name, parent_id) values
  ('00000000-0000-0000-0000-00000000ad04', '00000000-0000-0000-0000-0000000fd1aa', 'Ice tray', '00000000-0000-0000-0000-00000000ad03');
select is((select book_value || ' ' || current_value || ' ' || (months_owned > 150) from v_asset
            where id = '00000000-0000-0000-0000-00000000ad03'),
  '20000.00 20000.00 true', 'fully depreciated: worth its salvage value');
select is((select book_value || ' ' || coalesce(warranty_days_left::text, '-') from v_asset
            where id = '00000000-0000-0000-0000-00000000ad02'),
  '1500.00 -', 'no useful life: worth what it cost; no warranty date, no countdown');

insert into t_c values ('sale', rpc_asset_sell('{"asset_id":"00000000-0000-0000-0000-00000000ad03","sold_on":"2026-09-24",
  "sold_to":"Neighbour","price":25000,"account_id":"00000000-0000-0000-0000-00000000bd01",
  "category_id":"00000000-0000-0000-0000-00000000ed08","fingerprint":"mthg4","line_fingerprint":"mthg4-0-s",
  "include_parts":true}'));
select is((select t.type || ' ' || t.total || ' ' || l.raw_name || ' ' || (t.id = (v ->> 'transaction_id')::uuid)
             from t_c, money_transaction t join transaction_line l on l.transaction_id = t.id
            where k = 'sale' and t.fingerprint = 'mthg4'),
  'income 25000.00 Sold: Fridge true', 'selling makes the income');
select is((select string_agg(name || ':' || status || ':' || coalesce(sold_price::text, '-') || ':'
                             || (sale_transaction_id = pg_temp.tx('mthg4')), ' ' order by name)
             from asset where id in ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-00000000ad04')),
  'Fridge:sold:25000.00:true Ice tray:sold:-:true', 'the fridge and its part are sold with that income');
select is((select current_value || ' ' || sale_gain || ' ' || cost_of_ownership from v_asset
            where id = '00000000-0000-0000-0000-00000000ad03'),
  '0 5000.00 95000.00', 'sold: nothing left, Rs 5,000 over book value, cost of ownership net of the sale');
select throws_ok($$select rpc_asset_sell('{"asset_id":"00000000-0000-0000-0000-00000000ad03","price":1,
  "account_id":"00000000-0000-0000-0000-00000000bd01","category_id":"00000000-0000-0000-0000-00000000ed08",
  "fingerprint":"mthg5","line_fingerprint":"mthg5-0-s"}')$$, 'GDSLD', null, 'a thing can''t be sold twice');
select throws_ok($$update asset set status = 'in_use' where id = '00000000-0000-0000-0000-00000000ad03'$$,
  'GDSLD', null, 'a sold thing comes back only by undoing the sale');
select lives_ok($$select rpc_asset_unsell('00000000-0000-0000-0000-00000000ad03')$$, 'undo the sale');
select is((select count(*)::int from money_transaction where fingerprint = 'mthg4') || ' '
          || (select string_agg(name || ':' || status || ':' || coalesce(sold_on::text, '-'), ' ' order by name)
                from asset where id in ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-00000000ad04')),
  '0 Fridge:in_use:- Ice tray:in_use:-', 'the income is gone; both are back in use');
select lives_ok($$select rpc_asset_sell('{"asset_id":"00000000-0000-0000-0000-00000000ad03","price":30000,
  "account_id":"00000000-0000-0000-0000-00000000bd01","category_id":"00000000-0000-0000-0000-00000000ed08",
  "fingerprint":"mthg6","line_fingerprint":"mthg6-0-s"}')$$, 'sold again (without the part)');
select lives_ok($$select rpc_delete_transaction(pg_temp.tx('mthg6'))$$, 'the income is deleted in Money');
select is((select status || ' ' || coalesce(sold_price::text, '-') from asset where id = '00000000-0000-0000-0000-00000000ad03'),
  'in_use -', 'deleting a sale''s income brings the thing back');
select is((select string_agg(verb, ',' order by id) from activity where entity_id = '00000000-0000-0000-0000-00000000ad03'),
  'created,sold,unsold,sold,unsold', 'the timeline records the sales');

-- ── Lend, return, move ────────────────────────────────────────────────────────
select throws_ok($$update asset set status = 'lent' where id = '00000000-0000-0000-0000-00000000ad02'$$,
  '23514', null, 'lending needs a name');
update asset set status = 'lent', lent_to = ' Amma ', lent_on = '2026-09-24' where id = '00000000-0000-0000-0000-00000000ad02';
update asset set status = 'in_use' where id = '00000000-0000-0000-0000-00000000ad02';
update asset set location_id = '00000000-0000-0000-0000-00000000cd02' where id = '00000000-0000-0000-0000-00000000ad01';
select is((select string_agg(verb || ':' || coalesce(summary, '-'), ' ' order by id) from activity
            where entity_id in ('00000000-0000-0000-0000-00000000ad02', '00000000-0000-0000-0000-00000000ad01')),
  'created:TV created:HDMI cable lent:Amma returned:Amma moved:Bedroom', 'lend, return and move are on the timeline');
select is((select coalesce(lent_to, '-') || ' ' || coalesce(lent_on::text, '-') from asset
            where id = '00000000-0000-0000-0000-00000000ad02'), '- -', 'returning clears who had it');

-- ── Split, A-numbers, places, deleting the bill ───────────────────────────────
insert into asset (id, household_id, name, quantity, purchase_price) values
  ('00000000-0000-0000-0000-00000000ad05', '00000000-0000-0000-0000-0000000fd1aa', 'Chair', 6, 30000.10);
insert into asset_tag (household_id, asset_id, tag_id) values
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-00000000ad05', '00000000-0000-0000-0000-00000000fe01');
select is((select cardinality(rpc_asset_split('00000000-0000-0000-0000-00000000ad05'))), 5, 'six chairs → five new rows');
select is((select count(*)::int || ' ' || sum(quantity) || ' ' || sum(purchase_price) || ' ' || max(purchase_price)
             from asset where name = 'Chair'),
  '6 6 30000.10 5000.02', 'one chair each, prices add up (the first absorbs the rounding)');
select is((select count(*)::int from asset_tag where tag_id = '00000000-0000-0000-0000-00000000fe01'), 6,
  'every chair keeps the tag');

delete from asset where id = '00000000-0000-0000-0000-00000000ad04';
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000ad06', '00000000-0000-0000-0000-0000000fd1aa', 'Kettle');
select is((select asset_no from asset where id = '00000000-0000-0000-0000-00000000ad06'), 11,
  'A-numbers are never reused (A-0004 was deleted; 10 were given before)');
select throws_ok($$delete from location where id = '00000000-0000-0000-0000-00000000cd02'$$, '23503', null,
  'a place with things in it can''t be deleted');

select lives_ok($$select rpc_delete_transaction(pg_temp.tx('bthg1'))$$, 'the TV''s bill is deleted');
select is((select coalesce(transaction_line_id::text, '-') || ' ' || purchase_price || ' ' || purchased_on || ' ' || vendor
             from asset where id = '00000000-0000-0000-0000-00000000ad01'),
  '- 200000.00 2026-09-01 Singer', 'the TV stays, with its price, date and shop; only the link goes');

select * from finish();
rollback;
