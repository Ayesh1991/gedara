-- Stock lots + journal: read-only tables (rule 1), household isolation for tables, views and every
-- stock RPC, viewer read-only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f5101', 'stl-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f5103', 'stl-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f5201', 'stl-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f51aa', 'Stl A'),
  ('00000000-0000-0000-0000-0000000f52bb', 'Stl B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f51aa', '00000000-0000-0000-0000-0000000f5101', 'owner'),
  ('00000000-0000-0000-0000-0000000f51aa', '00000000-0000-0000-0000-0000000f5103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f52bb', '00000000-0000-0000-0000-0000000f5201', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c501', '00000000-0000-0000-0000-0000000f51aa', 'Pantry A'),
  ('00000000-0000-0000-0000-00000000c5b1', '00000000-0000-0000-0000-0000000f52bb', 'Pantry B');
insert into product (id, household_id, name, stock_unit_id, default_location_id) values
  ('00000000-0000-0000-0000-00000000d501', '00000000-0000-0000-0000-0000000f51aa', 'Rice A', pg_temp.u('g'),
   '00000000-0000-0000-0000-00000000c501'),
  ('00000000-0000-0000-0000-00000000d5b1', '00000000-0000-0000-0000-0000000f52bb', 'Rice B', pg_temp.u('g'),
   '00000000-0000-0000-0000-00000000c5b1');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5101","role":"authenticated"}';

insert into t_c values ('buyA', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f51aa', 'product_id', '00000000-0000-0000-0000-00000000d501',
  'qty', 5, 'unit_id', pg_temp.u('kg'), 'total_cost', 1250)));
select is((select qty_remaining from stock_lot where product_id = '00000000-0000-0000-0000-00000000d501'), 5000.0000,
  'owner buys 5 kg of rice through the RPC');
select throws_ok($$insert into stock_lot (household_id, product_id, qty_initial, qty_remaining)
  values ('00000000-0000-0000-0000-0000000f51aa', '00000000-0000-0000-0000-00000000d501', 1, 1)$$,
  '42501', null, 'lots can''t be inserted directly');
select throws_ok($$update stock_lot set qty_remaining = 99999 where product_id = '00000000-0000-0000-0000-00000000d501'$$,
  '42501', null, 'stock can''t be edited directly');
select throws_ok($$insert into stock_movement (household_id, lot_id, product_id, delta, reason, correlation_id)
  values ('00000000-0000-0000-0000-0000000f51aa', (select (v ->> 'lot_id')::uuid from t_c where k = 'buyA'),
          '00000000-0000-0000-0000-00000000d501', 1, 'adjust', gen_random_uuid())$$,
  '42501', null, 'movements can''t be inserted directly');
select throws_ok($$delete from stock_movement where product_id = '00000000-0000-0000-0000-00000000d501'$$,
  '42501', null, 'the journal can''t be deleted from');
select throws_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f51aa', 'product_id', '00000000-0000-0000-0000-00000000d501',
  'qty', 1, 'location_id', '00000000-0000-0000-0000-00000000c5b1'))$$,
  '23503', null, 'stock can''t be put in another household''s place');
select is((select count(*)::int from v_stock_journal where product_id = '00000000-0000-0000-0000-00000000d501'), 1,
  'the owner sees the purchase in the journal');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5103","role":"authenticated"}';

select is((select count(*)::int from stock_lot where household_id = '00000000-0000-0000-0000-0000000f51aa'), 1,
  'viewer sees A''s lots');
select throws_ok($$select rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f51aa', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 1))$$,
  '42501', null, 'viewer can''t consume');
select throws_ok($$select rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'buyA'))$$,
  '42501', null, 'viewer can''t undo');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5201","role":"authenticated"}';

select is((select count(*)::int from stock_lot where household_id = '00000000-0000-0000-0000-0000000f51aa'), 0,
  'B can''t see A''s lots');
select is((select count(*)::int from stock_movement where household_id = '00000000-0000-0000-0000-0000000f51aa'), 0,
  'B can''t see A''s movements');
select is((select count(*)::int from v_stock where household_id = '00000000-0000-0000-0000-0000000f51aa')
          + (select count(*)::int from v_product_stock where household_id = '00000000-0000-0000-0000-0000000f51aa')
          + (select count(*)::int from v_stock_journal where household_id = '00000000-0000-0000-0000-0000000f51aa'), 0,
  'B can''t see A''s stock through the views');
select throws_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f51aa', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 1))$$,
  '42501', null, 'B can''t buy into A');
select throws_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 1))$$,
  '23503', null, 'B can''t buy A''s product into B');
select throws_ok($$select rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f51aa', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 1))$$,
  '42501', null, 'B can''t consume A''s stock');
select throws_ok($$select rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 1))$$,
  '23503', null, 'B can''t consume A''s product through B');
select throws_ok($$select rpc_open(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'lot_id', (select v ->> 'lot_id' from t_c where k = 'buyA')))$$,
  '23503', null, 'B can''t open A''s lot');
select throws_ok($$select rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'to_location_id', '00000000-0000-0000-0000-00000000c5b1',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buyA')))$$,
  '23503', null, 'B can''t move A''s lot into B');
select throws_ok($$select rpc_set_lot_due(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'lot_id', (select v ->> 'lot_id' from t_c where k = 'buyA'),
  'due_date', '2030-01-01'))$$,
  '23503', null, 'B can''t change A''s due dates');
select throws_ok($$select rpc_inventory(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'product_id', '00000000-0000-0000-0000-00000000d501', 'qty', 0))$$,
  '23503', null, 'B can''t count A''s product');
select throws_ok($$select rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'buyA'))$$,
  '42501', null, 'B can''t undo A''s actions');

insert into t_c values ('buyB', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'product_id', '00000000-0000-0000-0000-00000000d5b1', 'qty', 100)));
select throws_ok($$select rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f52bb', 'to_location_id', '00000000-0000-0000-0000-00000000c501',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buyB')))$$,
  '23503', null, 'B can''t move its stock into A''s place');
select is((select count(*)::int from stock_lot), 1, 'B sees only its own lot');

-- ── Owner of A again ──────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5101","role":"authenticated"}';

select is((select qty_remaining from stock_lot where product_id = '00000000-0000-0000-0000-00000000d501'), 5000.0000,
  'nothing B or the viewer tried changed A''s stock');
select is((select count(*)::int from stock_movement where household_id = '00000000-0000-0000-0000-0000000f51aa'), 1,
  '… or its journal');

select * from finish();
rollback;
