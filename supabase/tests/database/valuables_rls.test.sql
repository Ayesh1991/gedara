-- Valuables (Phase 10, migration 98): "thing yes, place no".
-- A valuable thing stays visible to members and viewers, but not where it is kept; a valuable place
-- (the safe) and everything inside it is the owner's only. Every path that could reveal the place is
-- checked as member and viewer: asset, v_asset, asset_place_private, location, stock, attachment,
-- storage, activity, move_op, search_all, rpc_move. Only the owner sets the flags; B never sees A.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e1001', 'val-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000e1002', 'val-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000e1003', 'val-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000e2001', 'val-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000e10aa', 'Val A'),
  ('00000000-0000-0000-0000-0000000e20bb', 'Val B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1001', 'owner'),
  ('00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1002', 'member'),
  ('00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1003', 'viewer'),
  ('00000000-0000-0000-0000-0000000e20bb', '00000000-0000-0000-0000-0000000e2001', 'owner');
-- A: Bedroom › Safe › Box, Bedroom › Drawer.  B: Room B.
insert into location (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000e1c01', '00000000-0000-0000-0000-0000000e10aa', null, 'Bedroom'),
  ('00000000-0000-0000-0000-0000000e1cb1', '00000000-0000-0000-0000-0000000e20bb', null, 'Room B');
insert into location (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000e1c02', '00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1c01', 'Safe'),
  ('00000000-0000-0000-0000-0000000e1c04', '00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1c01', 'Drawer');
insert into location (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000e1c03', '00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1c02', 'Box');
insert into asset (id, household_id, name, location_id) values
  ('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e10aa', 'Gold chain', '00000000-0000-0000-0000-0000000e1c04'),
  ('00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e10aa', 'Cash envelope', '00000000-0000-0000-0000-0000000e1c03'),
  ('00000000-0000-0000-0000-0000000e1a03', '00000000-0000-0000-0000-0000000e10aa', 'TV', '00000000-0000-0000-0000-0000000e1c01'),
  ('00000000-0000-0000-0000-0000000e1ab1', '00000000-0000-0000-0000-0000000e20bb', 'Radio B', '00000000-0000-0000-0000-0000000e1cb1');
insert into product (id, household_id, name, stock_unit_id) values
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e10aa', 'Gold coins', pg_temp.u('g'));
insert into attachment (household_id, entity_type, entity_id, kind, storage_path, mime, bytes) values
  ('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a01', 'photo',
   '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a01/p.webp', 'image/webp', 10),
  ('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a02', 'photo',
   '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a02/p.webp', 'image/webp', 10),
  ('00000000-0000-0000-0000-0000000e10aa', 'location', '00000000-0000-0000-0000-0000000e1c02', 'photo',
   '00000000-0000-0000-0000-0000000e10aa/location/00000000-0000-0000-0000-0000000e1c02/p.webp', 'image/webp', 10),
  ('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a03', 'photo',
   '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a03/p.webp', 'image/webp', 10);
insert into storage.objects (bucket_id, name) values
  ('household-files', '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a01/p.webp'),
  ('household-files', '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a02/p.webp'),
  ('household-files', '00000000-0000-0000-0000-0000000e10aa/location/00000000-0000-0000-0000-0000000e1c02/p.webp'),
  ('household-files', '00000000-0000-0000-0000-0000000e10aa/asset/00000000-0000-0000-0000-0000000e1a03/p.webp');

select ok(not exists (select 1 from information_schema.column_privileges
                       where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE')
                         and ((table_name = 'asset' and column_name = 'valuable')
                           or (table_name = 'location' and column_name in ('valuable', 'in_valuable')))),
  'clients have no insert/update grant on the valuable flags');

set local role authenticated;

-- ── Owner of A marks the safe and the chain ───────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e1001","role":"authenticated"}';

select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'location', '00000000-0000-0000-0000-0000000e1c02', true)$$,
  'owner marks the safe valuable');
select is((select string_agg(name || '=' || in_valuable, ',' order by name) from location
            where household_id = '00000000-0000-0000-0000-0000000e10aa'),
  'Bedroom=false,Box=true,Drawer=false,Safe=true', 'the safe and the box inside it are valuable places');
select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a01', true)$$,
  'owner marks the gold chain valuable');
select is((select location_id from asset where id = '00000000-0000-0000-0000-0000000e1a01'), null,
  'a valuable thing keeps no place on the asset row');
select is((select location_id from asset_place_private where asset_id = '00000000-0000-0000-0000-0000000e1a01'),
  '00000000-0000-0000-0000-0000000e1c04'::uuid, 'its place is kept privately');
select is((select location_path || ' ' || place_private from v_asset where id = '00000000-0000-0000-0000-0000000e1a01'),
  'Bedroom › Drawer false', 'the owner still sees where the chain is');
select lives_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000e10aa', 'product_id', '00000000-0000-0000-0000-0000000e1d01',
  'qty', 10, 'unit_id', pg_temp.u('g'), 'total_cost', 1000,
  'location_id', '00000000-0000-0000-0000-0000000e1c02'))$$, 'owner stocks gold coins in the safe');
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1c01')$$,
  'owner moves the chain to the bedroom');
select is((select location_id from asset_place_private where asset_id = '00000000-0000-0000-0000-0000000e1a01'),
  '00000000-0000-0000-0000-0000000e1c01'::uuid, 'the move lands in the private place');
select is((select location_id from asset where id = '00000000-0000-0000-0000-0000000e1a01'), null,
  'the asset row still shows no place after a move');
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-0000000e1a03', '00000000-0000-0000-0000-0000000e1c04')$$,
  'owner moves the TV to the drawer');
select is((select count(*)::int from location where household_id = '00000000-0000-0000-0000-0000000e10aa'), 4,
  'the owner sees all four places');
select is((select count(*)::int from asset), 3, 'the owner sees all three things');
select is((select count(*)::int from stock_lot), 1, 'the owner sees the coins in the safe');
select is((select count(*)::int from attachment), 4, 'the owner sees every photo');

-- ── Member of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e1002","role":"authenticated"}';

select is((select string_agg(name, ',' order by name) from location), 'Bedroom,Drawer',
  'member doesn''t see the safe or the box inside it');
select is((select string_agg(name, ',' order by name) from asset), 'Gold chain,TV',
  'member sees the valuable thing, not the cash inside the safe');
select is((select location_id from asset where id = '00000000-0000-0000-0000-0000000e1a01'), null,
  'member: the chain has no place on its row');
select is((select coalesce(location_id::text, '-') || ' ' || coalesce(location_path, '-') || ' ' || place_private
             from v_asset where id = '00000000-0000-0000-0000-0000000e1a01'),
  '- - true', 'member: v_asset says the chain''s place is private');
select is((select count(*)::int from asset_place_private), 0, 'member can''t read private places');
select is((select count(*)::int from stock_lot), 0, 'member doesn''t see stock in the safe');
select is((select count(*)::int from stock_movement), 0, 'member doesn''t see stock movements in the safe');
select is((select string_agg(entity_id::text, ',') from attachment), '00000000-0000-0000-0000-0000000e1a03',
  'member sees only the TV''s photo (not the chain''s, the cash''s or the safe''s)');
select is((select count(*)::int from storage.objects where name like '00000000-0000-0000-0000-0000000e10aa/%'), 1,
  'member can open only the TV''s photo file');
select is((select count(*)::int from activity where entity_id in
            ('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1c02')),
  0, 'member sees no history of the chain, the cash or the safe');
select is((select count(*)::int from activity where entity_id = '00000000-0000-0000-0000-0000000e1a03' and verb = 'moved'), 1,
  'member still sees the TV''s move');
select is((select count(*)::int from move_op), 1, 'member sees the TV''s move, not the chain''s');
select is((select count(*)::int from search_all('00000000-0000-0000-0000-0000000e10aa', 'Safe')), 0,
  'search finds no safe for the member');
select is((select count(*)::int from search_all('00000000-0000-0000-0000-0000000e10aa', 'Cash envelope')), 0,
  'search finds no cash for the member');
select ok(not exists (select 1 from search_all('00000000-0000-0000-0000-0000000e10aa', 'Gold chain')
                       where coalesce(subtitle, '') ilike '%bedroom%'),
  'search shows the chain without its place');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1c01')$$,
  '23503', null, 'member can''t move the cash out of the safe');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-0000000e1a03', '00000000-0000-0000-0000-0000000e1c02')$$,
  '23503', null, 'member can''t move the TV into the safe');
select throws_ok($$select rpc_move(gen_random_uuid(), 'location', '00000000-0000-0000-0000-0000000e1c03', null)$$,
  '23503', null, 'member can''t move the box out of the safe');
select throws_ok($$insert into location (household_id, parent_id, name)
  values ('00000000-0000-0000-0000-0000000e10aa', '00000000-0000-0000-0000-0000000e1c02', 'Peek')$$,
  '42501', null, 'member can''t add a place inside the safe');
select throws_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a03', true)$$,
  '42501', null, 'member can''t mark valuables');
select throws_ok($$update asset set valuable = false where id = '00000000-0000-0000-0000-0000000e1a01'$$,
  '42501', null, 'member can''t clear the flag directly');
update location set name = 'Opened' where id = '00000000-0000-0000-0000-0000000e1c02';
update asset set name = 'Taken' where id = '00000000-0000-0000-0000-0000000e1a02';
select lives_ok($$update asset set location_id = '00000000-0000-0000-0000-0000000e1c04' where id = '00000000-0000-0000-0000-0000000e1a01'$$,
  'member may put the chain somewhere');
select is((select location_id from asset where id = '00000000-0000-0000-0000-0000000e1a01'), null,
  '… and its row still shows no place');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e1003","role":"authenticated"}';

select is((select count(*)::int from location), 2, 'viewer doesn''t see the safe or the box');
select is((select count(*)::int from asset), 2, 'viewer sees the chain and the TV only');
select is((select coalesce(location_path, '-') || ' ' || place_private from v_asset where id = '00000000-0000-0000-0000-0000000e1a01'),
  '- true', 'viewer: the chain''s place is private');
select is((select count(*)::int from attachment), 1, 'viewer sees only the TV''s photo');
select is((select count(*)::int from storage.objects where name like '00000000-0000-0000-0000-0000000e10aa/%'), 1,
  'viewer can open only the TV''s photo file');
select is((select count(*)::int from activity where entity_id = '00000000-0000-0000-0000-0000000e1a01'), 0,
  'viewer sees no history of the chain');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e2001","role":"authenticated"}';

select is((select count(*)::int from asset where household_id = '00000000-0000-0000-0000-0000000e10aa'), 0, 'B sees none of A''s things');
select is((select count(*)::int from asset_place_private), 0, 'B sees none of A''s private places');
select throws_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a03', true)$$,
  '42501', null, 'B can''t mark A''s things');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-0000000e1a03', null)$$,
  '23503', null, 'B can''t move A''s things');

-- ── Owner of A turns it off again ─────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e1001","role":"authenticated"}';

select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'asset', '00000000-0000-0000-0000-0000000e1a01', false)$$,
  'owner un-marks the chain');
select is((select location_id from asset where id = '00000000-0000-0000-0000-0000000e1a01'),
  '00000000-0000-0000-0000-0000000e1c04'::uuid, 'the chain''s place comes back to its row');
select is((select count(*)::int from asset_place_private), 0, 'and the private row is gone');
select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e10aa', 'location', '00000000-0000-0000-0000-0000000e1c02', false)$$,
  'owner un-marks the safe');
select is((select count(*)::int from location where in_valuable), 0, 'no valuable places remain');

reset role;
select is((select name from location where id = '00000000-0000-0000-0000-0000000e1c02'), 'Safe', 'the member''s rename of the safe did nothing');
select is((select name from asset where id = '00000000-0000-0000-0000-0000000e1a02'), 'Cash envelope', 'the member''s rename of the cash did nothing');

select * from finish();
rollback;
