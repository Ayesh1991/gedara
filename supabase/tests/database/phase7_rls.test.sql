-- Phase 7 RLS: another household can't read or write stock_op, floor_plan (+ pins), drive_source,
-- scan_file / v_scan_file, export_run, lot codes or shopping ticks; clients never write the
-- op log, the scan inbox or the export log directly; viewers read only; anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f9101', 'p7rls-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9103', 'p7rls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9201', 'p7rls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f91aa', 'P7 RLS A'),
  ('00000000-0000-0000-0000-0000000f92bb', 'P7 RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f91aa', '00000000-0000-0000-0000-0000000f9101', 'owner'),
  ('00000000-0000-0000-0000-0000000f91aa', '00000000-0000-0000-0000-0000000f9103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f92bb', '00000000-0000-0000-0000-0000000f9201', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c901', '00000000-0000-0000-0000-0000000f91aa', 'Kitchen A'),
  ('00000000-0000-0000-0000-00000000c9b1', '00000000-0000-0000-0000-0000000f92bb', 'Kitchen B');
insert into product (id, household_id, name, stock_unit_id, due_type) values
  ('00000000-0000-0000-0000-00000000d901', '00000000-0000-0000-0000-0000000f91aa', 'Rice',
   (select id from unit where household_id is null and code = 'g'), 'none');
insert into shopping_list_item (id, household_id, free_text) values
  ('00000000-0000-0000-0000-00000000e901', '00000000-0000-0000-0000-0000000f91aa', 'Soap');
insert into floor_plan (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-0000000f91aa', 'Ground A'),
  ('00000000-0000-0000-0000-00000000f9b1', '00000000-0000-0000-0000-0000000f92bb', 'Ground B');
insert into drive_source (household_id, folder_id) values
  ('00000000-0000-0000-0000-0000000f91aa', 'folderAAAAAAAAAA');
insert into scan_file (household_id, drive_file_id, name, mime, modified_at, doc_type, payload) values
  ('00000000-0000-0000-0000-0000000f91aa', 'fileAAAAAAAAAA', 'a.json', 'application/json', now(), 'bill', '[]');
insert into export_run (household_id, bytes) values ('00000000-0000-0000-0000-0000000f91aa', 1);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

set local role authenticated;

-- ── Owner A makes some history ────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9101","role":"authenticated"}';
insert into t_c values ('buy', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f91aa',
  'product_id', '00000000-0000-0000-0000-00000000d901', 'qty', 1000, 'total_cost', 300)));
insert into t_c values ('op', rpc_stock_op('00000000-0000-0000-0000-0000000002a1', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f91aa', 'product_id', '00000000-0000-0000-0000-00000000d901', 'qty', 100)));
select is((select count(*)::int from stock_op), 1, 'owner sees A''s op log');
select is((select count(*)::int from floor_plan), 1, 'owner sees A''s floor plans only');
select throws_ok($$insert into stock_op (household_id, op_id, action, correlation_id, result)
  values ('00000000-0000-0000-0000-0000000f91aa', gen_random_uuid(), 'consume', gen_random_uuid(), '{}')$$,
  '42501', null, 'the op log is written by rpc_stock_op only');
select throws_ok($$insert into scan_file (household_id, drive_file_id, name, mime, modified_at, parse_error)
  values ('00000000-0000-0000-0000-0000000f91aa', 'fileBBBBBBBBBB', 'x', 'text/plain', now(), 'x')$$,
  '42501', null, 'the scan inbox is written by its RPCs only');
select throws_ok($$insert into export_run (household_id) values ('00000000-0000-0000-0000-0000000f91aa')$$,
  '42501', null, 'the export log is written by rpc_export_done only');
select throws_ok($$update location set floor_plan_id = '00000000-0000-0000-0000-00000000f9b1'
  where id = '00000000-0000-0000-0000-00000000c901'$$, '23503', null, 'a place can''t be pinned on B''s plan');

-- ── Owner B: nothing of A ─────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9201","role":"authenticated"}';
select is((select count(*)::int from stock_op), 0, 'B sees none of A''s ops');
select is((select count(*)::int from floor_plan), 1, 'B sees only B''s floor plan');
select is((select count(*)::int from drive_source), 0, 'B doesn''t see A''s Drive folder');
select is((select count(*)::int from scan_file) + (select count(*)::int from v_scan_file), 0, 'B doesn''t see A''s scanned files');
select is((select count(*)::int from export_run), 0, 'B doesn''t see A''s exports');
select throws_ok($$insert into floor_plan (household_id, name) values ('00000000-0000-0000-0000-0000000f91aa', 'Sneaky')$$,
  '42501', null, 'B can''t add a plan to A');
update floor_plan set name = 'Hacked' where id = '00000000-0000-0000-0000-00000000f901';
delete from floor_plan where id = '00000000-0000-0000-0000-00000000f901';
select throws_ok($$insert into drive_source (household_id, folder_id) values ('00000000-0000-0000-0000-0000000f91aa', 'folderBBBBBBBBBB')$$,
  '42501', null, 'B can''t set A''s Drive folder');
update drive_source set folder_id = 'folderBBBBBBBBBB' where household_id = '00000000-0000-0000-0000-0000000f91aa';
select throws_ok($$select rpc_stock_op(gen_random_uuid(), 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f91aa', 'product_id', '00000000-0000-0000-0000-00000000d901', 'qty', 1))$$,
  '42501', null, 'B can''t use A''s stock');
select throws_ok($$select rpc_stock_op('00000000-0000-0000-0000-0000000002a1', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f92bb', 'product_id', '00000000-0000-0000-0000-00000000d901', 'qty', 1))$$,
  '23503', null, '… not even by reusing A''s op id under B (op ids are per household; A''s product is unknown to B)');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e901', true), 'gone', 'A''s list item doesn''t exist for B');
select throws_ok($$select rpc_lot_code((select id from stock_lot limit 1))$$, '23503', null, 'B can''t label A''s lots');
select throws_ok($$select rpc_scan_sync_begin('00000000-0000-0000-0000-0000000f91aa')$$, '42501', null, 'B can''t sync A''s folder');
select throws_ok($$select rpc_scan_files_upsert('00000000-0000-0000-0000-0000000f91aa', '[]')$$, '42501', null,
  'B can''t write A''s scan inbox');
select throws_ok($$select rpc_export_done('00000000-0000-0000-0000-0000000f91aa', 1, false, '{}')$$, '42501', null,
  'B can''t log an export for A');

-- ── Viewer A: reads, doesn't write ────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9103","role":"authenticated"}';
select is((select name from floor_plan), 'Ground A', 'A''s plan is untouched by B, and the viewer sees it');
select is((select folder_id from drive_source), 'folderAAAAAAAAAA', 'A''s folder is untouched by B');
select is((select count(*)::int from scan_file), 1, 'the viewer sees the scan inbox');
select throws_ok($$insert into floor_plan (household_id, name) values ('00000000-0000-0000-0000-0000000f91aa', 'Viewer')$$,
  '42501', null, 'a viewer can''t add a plan');
select throws_ok($$select rpc_stock_op(gen_random_uuid(), 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f91aa', 'product_id', '00000000-0000-0000-0000-00000000d901', 'qty', 1))$$,
  '42501', null, 'a viewer can''t use stock');
select throws_ok($$select rpc_shopping_tick('00000000-0000-0000-0000-00000000e901', true)$$, '42501', null,
  'a viewer can''t tick');
select throws_ok($$select rpc_scan_file_ignore((select id from scan_file limit 1), true)$$, '42501', null,
  'a viewer can''t ignore files');
select is((select done from shopping_list_item where id = '00000000-0000-0000-0000-00000000e901'), false, 'the item is still open');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from floor_plan$$, '42501', null, 'anon can''t read floor plans');
select throws_ok($$select rpc_stock_op(gen_random_uuid(), 'consume', '{}')$$, '42501', null, 'anon can''t call rpc_stock_op');

select * from finish();
rollback;
