-- location: household isolation, viewer read-only, immutable codes, same-household parents,
-- no cycles, breadcrumb paths that follow renames and moves, non-empty places can't be deleted.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f1001', 'loc-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f1003', 'loc-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f2001', 'loc-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f00aa', 'Loc A'),
  ('00000000-0000-0000-0000-0000000f00bb', 'Loc B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f00aa', '00000000-0000-0000-0000-0000000f1001', 'owner'),
  ('00000000-0000-0000-0000-0000000f00aa', '00000000-0000-0000-0000-0000000f1003', 'viewer'),
  ('00000000-0000-0000-0000-0000000f00bb', '00000000-0000-0000-0000-0000000f2001', 'owner');

-- A: Kitchen › Pantry › Box 3 ; B: Garage
insert into location (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000f00aa', null, '  Kitchen '),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000f00aa', '00000000-0000-0000-0000-00000000c001', 'Pantry'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f00aa', '00000000-0000-0000-0000-00000000c002', 'Box 3'),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-0000000f00bb', null, 'Garage');

select has_table('public', 'location', 'location table exists');
select is((select path from location where id = '00000000-0000-0000-0000-00000000c003'),
  'Kitchen › Pantry › Box 3', 'path is the trimmed breadcrumb');
select ok((select bool_and(code ~ '^HL:LOC:[0-9A-HJKMNP-TV-Z]{6}$') from location
            where id::text like '00000000-0000-0000-0000-00000000c0%'), 'codes are HL:LOC + 6 Crockford chars');
select is((select count(distinct code)::int from location where id::text like '00000000-0000-0000-0000-00000000c0%'), 4,
  'every place gets its own code');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f2001","role":"authenticated"}';

select is((select count(*)::int from location where household_id = '00000000-0000-0000-0000-0000000f00aa'), 0,
  'B cannot see A''s places');
select is((select count(*)::int from location where code = (select code from location where id = '00000000-0000-0000-0000-00000000c0b1')), 1,
  'B sees its own place');
update location set name = 'hacked' where id = '00000000-0000-0000-0000-00000000c001';
delete from location where id = '00000000-0000-0000-0000-00000000c003';
select throws_ok(
  $$insert into location (household_id, name) values ('00000000-0000-0000-0000-0000000f00aa', 'rogue')$$,
  '42501', null, 'B cannot insert into A');
select throws_ok(
  $$insert into location (household_id, parent_id, name)
    values ('00000000-0000-0000-0000-0000000f00bb', '00000000-0000-0000-0000-00000000c001', 'inside A')$$,
  '23503', null, 'B cannot hang a place under A''s place');

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1001","role":"authenticated"}';

select is((select name from location where id = '00000000-0000-0000-0000-00000000c001'), 'Kitchen',
  'B''s update did nothing');
select is((select count(*)::int from location where household_id = '00000000-0000-0000-0000-0000000f00aa'), 3,
  'B''s delete did nothing');
select lives_ok(
  $$insert into location (id, household_id, parent_id, name, kind)
    values ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-0000000f00aa',
            '00000000-0000-0000-0000-00000000c002', 'Shelf', 'shelf')$$,
  'owner can add a place');
select throws_ok(
  $$insert into location (household_id, name, code) values ('00000000-0000-0000-0000-0000000f00aa', 'x', 'HL:LOC:000000')$$,
  '42501', null, 'clients cannot choose a code');
select throws_ok(
  $$update location set code = 'HL:LOC:000000' where id = '00000000-0000-0000-0000-00000000c001'$$,
  '42501', null, 'codes are immutable');
select throws_ok(
  $$update location set path = 'fake' where id = '00000000-0000-0000-0000-00000000c001'$$,
  '42501', null, 'path is not client-writable');
select throws_ok(
  $$update location set household_id = '00000000-0000-0000-0000-0000000f00bb' where id = '00000000-0000-0000-0000-00000000c001'$$,
  '42501', null, 'places cannot change household');
select throws_ok(
  $$update location set parent_id = '00000000-0000-0000-0000-00000000c003' where id = '00000000-0000-0000-0000-00000000c001'$$,
  '23514', null, 'cannot move a place into its own descendant');
select throws_ok(
  $$update location set parent_id = id where id = '00000000-0000-0000-0000-00000000c002'$$,
  '23514', null, 'cannot move a place into itself');

update location set name = 'Cook room' where id = '00000000-0000-0000-0000-00000000c001';
select is((select path from location where id = '00000000-0000-0000-0000-00000000c003'),
  'Cook room › Pantry › Box 3', 'rename cascades to grandchildren');
select is((select path from location where id = '00000000-0000-0000-0000-00000000c004'),
  'Cook room › Pantry › Shelf', 'rename cascades to every branch');

update location set parent_id = null where id = '00000000-0000-0000-0000-00000000c003';
select is((select path from location where id = '00000000-0000-0000-0000-00000000c003'),
  'Box 3', 'moving to the top re-paths');

select throws_ok(
  $$delete from location where id = '00000000-0000-0000-0000-00000000c002'$$,
  '23503', null, 'a place with places inside cannot be deleted');
select lives_ok(
  $$delete from location where id = '00000000-0000-0000-0000-00000000c004'$$,
  'an empty place can be deleted');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1003","role":"authenticated"}';

select is((select count(*)::int from location where household_id = '00000000-0000-0000-0000-0000000f00aa'), 3,
  'viewer sees A''s places');
select throws_ok(
  $$insert into location (household_id, name) values ('00000000-0000-0000-0000-0000000f00aa', 'viewer')$$,
  '42501', null, 'viewer cannot add places');
update location set name = 'viewer was here' where id = '00000000-0000-0000-0000-00000000c001';
delete from location where id = '00000000-0000-0000-0000-00000000c003';
select is((select name from location where id = '00000000-0000-0000-0000-00000000c001'), 'Cook room',
  'viewer cannot rename');
select is((select count(*)::int from location where household_id = '00000000-0000-0000-0000-0000000f00aa'), 3,
  'viewer cannot delete');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from location$$, '42501', null, 'anon has no access to location');

select * from finish();
rollback;
