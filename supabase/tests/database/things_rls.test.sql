-- Things (Phase 5): household isolation for asset, tag, asset_tag, category_field, maintenance_plan,
-- maintenance_log, activity and the Things views; viewers read-only; label code, A-number, sale
-- columns, logs and activity are never client-written.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(46);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fc101', 'things-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fc103', 'things-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fc201', 'things-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fc1aa', 'Things A'),
  ('00000000-0000-0000-0000-0000000fc2bb', 'Things B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc101', 'owner'),
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-0000000fc201', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-00000000ec01', '00000000-0000-0000-0000-0000000fc1aa', 'nonconsumable', 'Non-consumables', 'asset'),
  ('00000000-0000-0000-0000-00000000ecb1', '00000000-0000-0000-0000-0000000fc2bb', 'nonconsumable', 'Non-consumables', 'asset');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000fc1aa', 'Living room'),
  ('00000000-0000-0000-0000-00000000ccb1', '00000000-0000-0000-0000-0000000fc2bb', 'Room B');
insert into asset (id, household_id, name, category_id, location_id) values
  ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000fc1aa', 'TV',
   '00000000-0000-0000-0000-00000000ec01', '00000000-0000-0000-0000-00000000cc01'),
  ('00000000-0000-0000-0000-00000000cab1', '00000000-0000-0000-0000-0000000fc2bb', 'Radio B',
   '00000000-0000-0000-0000-00000000ecb1', '00000000-0000-0000-0000-00000000ccb1');
insert into tag (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-0000000fc1aa', 'Kitchen'),
  ('00000000-0000-0000-0000-00000000fab1', '00000000-0000-0000-0000-0000000fc2bb', 'Garage');
insert into asset_tag (household_id, asset_id, tag_id) values
  ('00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-00000000cab1', '00000000-0000-0000-0000-00000000fab1');
insert into category_field (id, household_id, category_id, key, label, type) values
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ec01', 'imei', 'IMEI', 'text'),
  ('00000000-0000-0000-0000-00000000fbb1', '00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-00000000ecb1', 'imei', 'IMEI', 'text');
insert into maintenance_plan (id, household_id, asset_id, name, every_days) values
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', 'Clean', 90),
  ('00000000-0000-0000-0000-00000000fcb1', '00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-00000000cab1', 'Tune', 30);
insert into maintenance_log (id, household_id, asset_id, title, cost) values
  ('00000000-0000-0000-0000-00000000fd01', '00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', 'Dusted', null),
  ('00000000-0000-0000-0000-00000000fdb1', '00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-00000000cab1', 'Fixed', 500);

select is((select count(*)::int from activity where verb = 'created' and entity_id in
            ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000cab1')),
  2, 'creating a thing writes its first timeline entry');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc101","role":"authenticated"}';

select is((select count(*)::int from asset), 1, 'owner sees A''s things only');
select lives_ok($$insert into asset (id, household_id, name, location_id)
  values ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-0000000fc1aa', '  Fridge ',
          '00000000-0000-0000-0000-00000000cc01')$$, 'owner adds a thing');
select ok((select code ~ '^HL:AST:[0-9A-HJKMNP-TV-Z]{6}$' and asset_no = 2 and name = 'Fridge' and created_by is not null
             from asset where id = '00000000-0000-0000-0000-00000000ca02'),
  'the database gives it an HL:AST code and the next A-number; name trimmed; author stamped');
select throws_ok($$insert into asset (household_id, name, code)
  values ('00000000-0000-0000-0000-0000000fc1aa', 'X', 'HL:AST:AAAAAA')$$, '42501', null, 'the client can''t choose a code');
select throws_ok($$update asset set asset_no = 7 where id = '00000000-0000-0000-0000-00000000ca02'$$,
  '42501', null, 'the A-number can''t be changed');
select throws_ok($$update asset set sold_price = 1 where id = '00000000-0000-0000-0000-00000000ca02'$$,
  '42501', null, 'sale columns are written by the sale RPCs only');
select throws_ok($$update asset set status = 'sold' where id = '00000000-0000-0000-0000-00000000ca02'$$,
  'GDSLD', null, 'a thing can''t just be marked sold');
select throws_ok($$insert into asset (household_id, name)
  values ('00000000-0000-0000-0000-0000000fc2bb', 'Sneaky')$$, '42501', null, 'owner of A can''t add things to B');
select throws_ok($$insert into asset (household_id, name, location_id)
  values ('00000000-0000-0000-0000-0000000fc1aa', 'Lost', '00000000-0000-0000-0000-00000000ccb1')$$,
  '23503', null, 'a thing can''t be put in B''s place');
update asset set name = 'Hacked' where id = '00000000-0000-0000-0000-00000000cab1';
delete from asset where id = '00000000-0000-0000-0000-00000000cab1';

select is((select count(*)::int from tag), 1, 'owner sees A''s tags only');
select lives_ok($$insert into tag (household_id, name) values ('00000000-0000-0000-0000-0000000fc1aa', 'Heirloom')$$,
  'owner adds a tag');
select throws_ok($$insert into tag (household_id, name) values ('00000000-0000-0000-0000-0000000fc1aa', ' kitchen ')$$,
  '23505', null, 'tag names are unique per household, ignoring case');
select lives_ok($$insert into asset_tag (household_id, asset_id, tag_id) values
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000fa01')$$,
  'owner tags a thing');
select throws_ok($$insert into asset_tag (household_id, asset_id, tag_id) values
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000fab1')$$,
  '23503', null, 'B''s tag can''t be put on A''s thing');
select is((select count(*)::int from asset_tag), 1, 'owner sees A''s tag links only');

select is((select count(*)::int from category_field), 1, 'owner sees A''s field templates only');
select throws_ok($$insert into category_field (household_id, category_id, key, label, type)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ec01', 'size', 'Size', 'select')$$,
  '23514', null, 'a select field needs options');
select lives_ok($$insert into category_field (household_id, category_id, key, label, type, options)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ec01', 'size', 'Size', 'select',
          array[' S', 'M', 's', '', 'L'])$$, 'owner adds a select field');
select is((select array_to_string(options, ',') from category_field where key = 'size'), 'S,M,L',
  'options trimmed, blanks and case-insensitive duplicates dropped, order kept');
select throws_ok($$update category_field set key = 'other' where key = 'size'$$, '42501', null,
  'a field''s key is fixed');

select is((select count(*)::int from maintenance_plan), 1, 'owner sees A''s plans only');
select lives_ok($$insert into maintenance_plan (household_id, asset_id, name, every_days)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca02', 'Defrost', 180)$$,
  'owner adds a plan');
select throws_ok($$insert into maintenance_plan (household_id, asset_id, name)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000cab1', 'Steal')$$,
  '23503', null, 'a plan can''t be put on B''s thing');
select is((select count(*)::int from maintenance_log), 1, 'owner sees A''s logs only');
select throws_ok($$insert into maintenance_log (household_id, asset_id, title)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', 'Direct')$$,
  '42501', null, 'logs are written by rpc_log_maintenance only');
select lives_ok($$update maintenance_log set title = 'Dusted well' where id = '00000000-0000-0000-0000-00000000fd01'$$,
  'the words of a log stay editable');
select throws_ok($$update maintenance_log set cost = 1 where id = '00000000-0000-0000-0000-00000000fd01'$$,
  '42501', null, 'a log''s cost is fixed (it matches the ledger)');

select is((select count(*)::int from activity where entity_type = 'asset'), 2, 'owner sees A''s asset timeline only (TV and Fridge created)');
select throws_ok($$insert into activity (household_id, entity_type, entity_id, verb)
  values ('00000000-0000-0000-0000-0000000fc1aa', 'asset', '00000000-0000-0000-0000-00000000ca01', 'created')$$,
  '42501', null, 'the timeline is written by triggers only');

select lives_ok($$insert into attachment (household_id, entity_type, entity_id, kind, storage_path, mime, bytes, title)
  values ('00000000-0000-0000-0000-0000000fc1aa', 'asset', '00000000-0000-0000-0000-00000000ca01', 'manual',
          '00000000-0000-0000-0000-0000000fc1aa/asset/00000000-0000-0000-0000-00000000ca01/m.pdf',
          'application/pdf', 2400000, 'TV manual.pdf')$$, 'owner attaches a PDF manual with its file name');
select is((select count(*)::int || ' ' || sum(files) || ' ' || sum(bytes) from v_storage_usage), '1 1 2400000',
  'storage usage counts A''s files only');
select is((select count(*)::int from v_asset), 2, 'v_asset shows A''s things only');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc103","role":"authenticated"}';

select is((select count(*)::int from asset), 2, 'viewer sees A''s things');
select throws_ok($$insert into asset (household_id, name) values ('00000000-0000-0000-0000-0000000fc1aa', 'Nope')$$,
  '42501', null, 'viewer can''t add things');
update asset set name = 'Viewer was here' where id = '00000000-0000-0000-0000-00000000ca01';
select is((select name from asset where id = '00000000-0000-0000-0000-00000000ca01'), 'TV', 'viewer can''t edit things');
select throws_ok($$insert into tag (household_id, name) values ('00000000-0000-0000-0000-0000000fc1aa', 'Nope')$$,
  '42501', null, 'viewer can''t add tags');
select throws_ok($$insert into maintenance_plan (household_id, asset_id, name)
  values ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-00000000ca01', 'Nope')$$,
  '42501', null, 'viewer can''t add plans');
select throws_ok($$select rpc_log_maintenance('{"asset_id":"00000000-0000-0000-0000-00000000ca01","title":"x"}')$$,
  '42501', null, 'viewer can''t log maintenance');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc201","role":"authenticated"}';

select is((select string_agg(name, ',') from asset), 'Radio B', 'B sees only B''s thing, untouched by A');
select is((select count(*)::int from tag) || ' ' || (select count(*)::int from asset_tag) || ' '
          || (select count(*)::int from category_field) || ' ' || (select count(*)::int from maintenance_plan) || ' '
          || (select count(*)::int from maintenance_log) || ' ' || (select count(*)::int from activity where entity_type = 'asset'),
  '1 1 1 1 1 1', 'B sees only B''s tags, links, fields, plans, logs and timeline');
select is((select count(*)::int from v_asset) || ' ' || (select count(*)::int from v_maintenance_due) || ' '
          || (select count(*)::int from v_storage_usage),
  '1 1 0', 'B''s views show nothing of A');
select throws_ok($$select rpc_asset_split('00000000-0000-0000-0000-00000000ca01')$$, '42501', null,
  'B can''t call Things RPCs on A''s things');
select throws_ok($$select rpc_delete_maintenance_log('00000000-0000-0000-0000-00000000fd01')$$, '42501', null,
  'B can''t delete A''s logs');
update asset set name = 'Hacked' where id = '00000000-0000-0000-0000-00000000ca01';
delete from maintenance_plan where id = '00000000-0000-0000-0000-00000000fc01';

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc101","role":"authenticated"}';
select is((select name from asset where id = '00000000-0000-0000-0000-00000000ca01') || ' '
          || (select count(*)::int from maintenance_plan),
  'TV 2', 'B''s update and delete didn''t reach A');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from asset$$, '42501', null, 'anon has no access to things');

select * from finish();
rollback;
