-- Phase 7 behaviour: idempotent stock ops (replay, refused op leaves nothing, undo, wrappers),
-- shopping ticks (newest wins, same, stale, gone, "not now"), lot codes (on demand, stable,
-- immutable), floor-plan pins (range, same household, delete), the Drive scan inbox (throttle,
-- upsert, derived status) and the two new Attention items (scan_waiting, backup_due).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(58);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create function pg_temp.qty() returns numeric language sql stable as
  $$ select coalesce(sum(qty_remaining), 0) from public.stock_lot where product_id = '00000000-0000-0000-0000-00000000d801' $$;
create function pg_temp.kinds() returns text language sql stable as
  $$ select coalesce(string_agg(kind || '/' || severity || coalesce(':' || qty::int, ''), ' ' order by kind), '')
       from public.attention_feed('00000000-0000-0000-0000-0000000f81aa') $$;
create function pg_temp.scan(p_name text) returns text language sql stable as
  $$ select status || ' ' || bills_imported || '/' || bills_total from public.v_scan_file where name = p_name $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f8101', 'p7-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8102', 'p7-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8103', 'p7-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8201', 'p7-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f81aa', 'Phase7 A'),
  ('00000000-0000-0000-0000-0000000f82bb', 'Phase7 B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f81aa', '00000000-0000-0000-0000-0000000f8101', 'owner'),
  ('00000000-0000-0000-0000-0000000f81aa', '00000000-0000-0000-0000-0000000f8102', 'member'),
  ('00000000-0000-0000-0000-0000000f81aa', '00000000-0000-0000-0000-0000000f8103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f82bb', '00000000-0000-0000-0000-0000000f8201', 'owner');
insert into location (id, household_id, name, climate) values
  ('00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-0000000f81aa', 'Pantry', 'ambient'),
  ('00000000-0000-0000-0000-00000000c802', '00000000-0000-0000-0000-0000000f81aa', 'Kitchen', 'ambient');
insert into product (id, household_id, name, stock_unit_id, default_location_id, due_type) values
  ('00000000-0000-0000-0000-00000000d801', '00000000-0000-0000-0000-0000000f81aa', 'Milk', pg_temp.u('pcs'),
   '00000000-0000-0000-0000-00000000c801', 'none');
insert into shopping_list_item (id, household_id, free_text, dismissed) values
  ('00000000-0000-0000-0000-00000000e801', '00000000-0000-0000-0000-0000000f81aa', 'Candles', false),
  ('00000000-0000-0000-0000-00000000e802', '00000000-0000-0000-0000-0000000f81aa', 'Matches', true);
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000a801', '00000000-0000-0000-0000-0000000f81aa', 'Fridge'),
  ('00000000-0000-0000-0000-00000000a8b1', '00000000-0000-0000-0000-0000000f82bb', 'Radio B');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000b801', '00000000-0000-0000-0000-0000000f81aa', 'Cash', 'cash');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-00000000b811', '00000000-0000-0000-0000-0000000f81aa', 'expense',
   '00000000-0000-0000-0000-00000000b801', 'Keells', '2026-09-20', 100, 'bp7one');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000f81aa', '00000000-0000-0000-0000-00000000b811', 0, 'MILK', 100, 'bp7one-0-a');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8101","role":"authenticated"}';

-- ── Stock ops: a replay never takes stock twice ──────────────────────────────
insert into t_c values ('buy', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa',
  'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 3, 'total_cost', 300)));
insert into t_c values ('op1', rpc_stock_op('00000000-0000-0000-0000-0000000001a1', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 1),
  now() - interval '10 minutes'));
select is(pg_temp.qty(), 2.0000, 'the first send uses 1');
insert into t_c values ('op1again', rpc_stock_op('00000000-0000-0000-0000-0000000001a1', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 1)));
select is(pg_temp.qty(), 2.0000, 'the same op sent again uses nothing');
select is((select v ->> 'replayed' from t_c where k = 'op1again'), 'true', '… and says it was a replay');
select is((select v ->> 'correlation_id' from t_c where k = 'op1again'), (select v ->> 'correlation_id' from t_c where k = 'op1'),
  '… with the first send''s correlation id (so Undo still works)');
select is((select count(*)::int from stock_movement where reason = 'consume' and product_id = '00000000-0000-0000-0000-00000000d801'),
  1, 'exactly one consume movement');
select ok((select client_at < now() and action = 'consume' and actor = '00000000-0000-0000-0000-0000000f8101'
             from stock_op where op_id = '00000000-0000-0000-0000-0000000001a1'), 'the op keeps when it was tapped and who');
select lives_ok($$select rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'op1'))$$, 'undo through the stored correlation');
select is(pg_temp.qty(), 3.0000, 'undo gave the 1 back');
select lives_ok($$select rpc_stock_op('00000000-0000-0000-0000-0000000001a1', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 1))$$,
  'a late replay of the undone op …');
select is(pg_temp.qty(), 3.0000, '… still takes nothing');

insert into t_c values ('future', rpc_stock_op('00000000-0000-0000-0000-0000000001a9', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801',
                     'qty', 0.5), now() + interval '1 day'));
select ok((select client_at <= now() from stock_op where op_id = '00000000-0000-0000-0000-0000000001a9'),
  'a phone clock in the future is clamped to now');

select throws_ok($$select rpc_stock_op('00000000-0000-0000-0000-0000000001a2', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 5))$$,
  'GDSTK', null, 'not enough stock: refused');
select is((select count(*)::int from stock_op where op_id = '00000000-0000-0000-0000-0000000001a2'), 0,
  'a refused op leaves no trace, so it can be retried or parked');
select lives_ok($$select rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa',
  'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 5, 'total_cost', 500))$$, 'restocked');
select lives_ok($$select rpc_stock_op('00000000-0000-0000-0000-0000000001a2', 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 5))$$,
  'the same op id now goes through');
select is(pg_temp.qty(), 2.5000, '2.5 left (3 − 0.5 + 5 − 5)');

insert into t_c values ('mv', rpc_stock_op('00000000-0000-0000-0000-0000000001a3', 'transfer',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801',
                     'to_location_id', '00000000-0000-0000-0000-00000000c802')));
select is((select count(*)::int from stock_lot where product_id = '00000000-0000-0000-0000-00000000d801' and qty_remaining > 0
            and location_id <> '00000000-0000-0000-0000-00000000c802'), 0, 'transfer through the wrapper moves everything');
insert into t_c values ('open', rpc_stock_op('00000000-0000-0000-0000-0000000001a4', 'open',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa', 'product_id', '00000000-0000-0000-0000-00000000d801', 'qty', 1)));
select ok((select opened_at is not null from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'open')),
  'open through the wrapper');
select throws_ok($$select rpc_stock_op('00000000-0000-0000-0000-0000000001a5', 'inventory',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa'))$$, '23514', null, 'only consume / open / transfer');
select throws_ok($$select rpc_stock_op(null, 'consume',
  jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f81aa'))$$, '23514', null, 'an op id is required');

-- ── Shopping ticks ────────────────────────────────────────────────────────────
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e801', true), 'applied', 'tick');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e801', true), 'same', 'the same tick again is harmless');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e801', false, now() - interval '1 hour'), 'stale',
  'an older offline untick doesn''t override a newer change');
select is((select done from shopping_list_item where id = '00000000-0000-0000-0000-00000000e801'), true, '… it stays ticked');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e801', false, now()), 'applied', 'an untick from after the change applies');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e802', true), 'applied', 'a "Not now" item can be ticked …');
select is((select done::text || ' ' || dismissed::text from shopping_list_item where id = '00000000-0000-0000-0000-00000000e802'),
  'true false', '… and is no longer "Not now"');
select is(rpc_shopping_tick('00000000-0000-0000-0000-00000000e8ff', true), 'gone', 'a deleted item: gone');

-- ── Lot codes ─────────────────────────────────────────────────────────────────
insert into t_c values ('lot', to_jsonb(rpc_lot_code((select (v ->> 'lot_id')::uuid from t_c where k = 'buy'))));
select ok((select v #>> '{}' ~ '^HL:LOT:[0-9A-HJKMNP-TV-Z]{6}$' from t_c where k = 'lot'), 'a lot gets an HL:LOT code on demand');
select is(rpc_lot_code((select (v ->> 'lot_id')::uuid from t_c where k = 'buy')), (select v #>> '{}' from t_c where k = 'lot'),
  'asking again gives the same code');
select throws_ok($$update stock_lot set code = 'HL:LOT:AAAAAA'$$, '42501', null, 'clients can''t write codes');
reset role;
select throws_ok($$update stock_lot set code = 'HL:LOT:AAAAAA' where code is not null$$, '23514', null,
  'a printed code never changes, not even from inside the database');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8103","role":"authenticated"}';
select is(rpc_lot_code((select (v ->> 'lot_id')::uuid from t_c where k = 'buy')), (select v #>> '{}' from t_c where k = 'lot'),
  'a viewer can read an existing code');
select throws_ok($$select rpc_lot_code((select (v ->> 'lot_id')::uuid from t_c where k = 'open'))$$, '42501', null,
  '… but not create one');

-- ── Floor plan ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8102","role":"authenticated"}';
select lives_ok($$insert into floor_plan (id, household_id, name)
  values ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-0000000f81aa', 'Ground floor')$$, 'a member adds a floor plan');
select lives_ok($$update location set floor_plan_id = '00000000-0000-0000-0000-00000000f801', map_x = 0.25, map_y = 0.75
  where id = '00000000-0000-0000-0000-00000000c801'$$, 'and pins the pantry on it');
select throws_ok($$update location set map_x = 1.5 where id = '00000000-0000-0000-0000-00000000c801'$$, '23514', null,
  'pins stay on the picture (0–1)');
select lives_ok($$insert into attachment (household_id, entity_type, entity_id, storage_path, is_primary)
  values ('00000000-0000-0000-0000-0000000f81aa', 'floor_plan', '00000000-0000-0000-0000-00000000f801',
          '00000000-0000-0000-0000-0000000f81aa/floor_plan/x.webp', true)$$, 'the plan''s picture is an attachment');
select lives_ok($$delete from floor_plan where id = '00000000-0000-0000-0000-00000000f801'$$, 'delete the plan');
select is((select floor_plan_id is null from location where id = '00000000-0000-0000-0000-00000000c801')
          and not exists (select 1 from attachment where entity_type = 'floor_plan'), true,
  'its pins come off and its picture row goes');

-- ── Drive scan inbox ──────────────────────────────────────────────────────────
select throws_ok($$insert into drive_source (household_id, folder_id)
  values ('00000000-0000-0000-0000-0000000f81aa', 'folderTEST0000000000000000000000')$$, '42501', null,
  'only the owner sets the Drive folder');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8101","role":"authenticated"}';
select is(rpc_scan_sync_begin('00000000-0000-0000-0000-0000000f81aa') ->> 'reason', 'no_folder', 'no folder yet: nothing to do');
insert into drive_source (household_id, folder_id) values ('00000000-0000-0000-0000-0000000f81aa', 'folderTEST0000000000000000000000');
select is(rpc_scan_sync_begin('00000000-0000-0000-0000-0000000f81aa') ->> 'folder_id', 'folderTEST0000000000000000000000',
  'the owner sets the folder; a sync may start');
select is(rpc_scan_sync_begin('00000000-0000-0000-0000-0000000f81aa', true) ->> 'reason', 'recent',
  'not again within seconds, even with "Check now"');
select is(rpc_scan_files_upsert('00000000-0000-0000-0000-0000000f81aa', jsonb_build_array(
    jsonb_build_object('drive_file_id', 'drivefile0001', 'name', 'bills.json', 'mime', 'application/json',
      'modified_at', '2026-09-25T10:00:00Z', 'doc_type', 'bill', 'payload', '[{"shop":"Keells"},{"shop":"Cargills"}]'::jsonb,
      'bill_fps', jsonb_build_array('bp7one', 'bp7two')),
    jsonb_build_object('drive_file_id', 'drivefile0002', 'name', 'warranty.json', 'mime', 'application/json',
      'modified_at', '2026-09-25T10:05:00Z', 'doc_type', 'warranty', 'payload', '{"maker":"LG"}'::jsonb),
    jsonb_build_object('drive_file_id', 'drivefile0003', 'name', 'notes.txt', 'mime', 'text/plain',
      'modified_at', '2026-09-25T10:06:00Z', 'parse_error', 'not JSON'))), 3, 'three files stored');
select is(pg_temp.scan('bills.json') || ' · ' || pg_temp.scan('warranty.json') || ' · ' || pg_temp.scan('notes.txt'),
  'waiting 1/2 · waiting 0/0 · error 0/0', 'status is derived: one of two bills already in Money');
select ok(pg_temp.kinds() like '%scan_waiting/violet:2%', 'Home: 2 scanned files waiting');
reset role;
insert into money_transaction (household_id, type, account_id, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-0000000f81aa', 'expense', '00000000-0000-0000-0000-00000000b801', '2026-09-21', 50, 'bp7two');
set local role authenticated;
select is(pg_temp.scan('bills.json'), 'imported 2/2', 'importing the second bill completes the file');
select lives_ok($$select rpc_scan_file_asset((select id from scan_file where name = 'warranty.json'), '00000000-0000-0000-0000-00000000a801')$$,
  'the warranty card filled in the fridge');
select throws_ok($$select rpc_scan_file_asset((select id from scan_file where name = 'warranty.json'), '00000000-0000-0000-0000-00000000a8b1')$$,
  '23503', null, '… never another household''s thing');
select lives_ok($$select rpc_scan_file_ignore((select id from scan_file where name = 'notes.txt'), true)$$, 'ignore the bad file');
select is(pg_temp.scan('warranty.json') || ' · ' || pg_temp.scan('notes.txt'), 'imported 0/0 · ignored 0/0', 'both done');
select ok(pg_temp.kinds() not like '%scan_waiting%', 'nothing waiting any more');
select lives_ok($$select rpc_scan_files_upsert('00000000-0000-0000-0000-0000000f81aa', jsonb_build_array(
    jsonb_build_object('drive_file_id', 'drivefile0003', 'name', 'notes.txt', 'mime', 'text/plain',
      'modified_at', '2026-09-25T11:00:00Z', 'parse_error', 'still not JSON')))$$, 'a changed file is stored again …');
select is(pg_temp.scan('notes.txt') || ' ' || (select count(*) from scan_file), 'ignored 0/0 3', '… in place, still ignored');

-- ── Backup reminder ───────────────────────────────────────────────────────────
select ok(pg_temp.kinds() like '%backup_due/cyan%', 'never backed up: a reminder');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8103","role":"authenticated"}';
select isnt(rpc_export_done('00000000-0000-0000-0000-0000000f81aa', 12345, true, '{"product":1}'), null, 'a viewer may export');
select ok(pg_temp.kinds() not like '%backup_due%', 'the reminder goes after a backup');

select * from finish();
rollback;
