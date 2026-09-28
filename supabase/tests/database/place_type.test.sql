-- Phase 7d: new built-in place kinds (cupboard, rack, file) and the household's own place types:
-- names tidy + unique per household ignoring case, icons from the fixed set, a place points at a
-- type of its own household only, deleting a type leaves its places untyped; another household
-- can't read, add or use my types; a viewer reads only; anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7801', 'p7d-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7803', 'p7d-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7901', 'p7d-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f78aa', 'Types A'),
  ('00000000-0000-0000-0000-0000000f79bb', 'Types B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f78aa', '00000000-0000-0000-0000-0000000f7801', 'owner'),
  ('00000000-0000-0000-0000-0000000f78aa', '00000000-0000-0000-0000-0000000f7803', 'viewer'),
  ('00000000-0000-0000-0000-0000000f79bb', '00000000-0000-0000-0000-0000000f7901', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c791', '00000000-0000-0000-0000-0000000f79bb', 'Room B');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7801","role":"authenticated"}';

select lives_ok($$insert into location (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000c781', '00000000-0000-0000-0000-0000000f78aa', 'Hall cupboard', 'cupboard'),
  ('00000000-0000-0000-0000-00000000c782', '00000000-0000-0000-0000-0000000f78aa', 'Garage rack', 'rack'),
  ('00000000-0000-0000-0000-00000000c783', '00000000-0000-0000-0000-0000000f78aa', 'Tax papers', 'file')$$,
  'cupboard, rack and file are place kinds now');
select throws_ok($$insert into location (household_id, name, kind) values ('00000000-0000-0000-0000-0000000f78aa', 'X', 'basket')$$,
  '23514', null, 'other kinds still need a type of your own');
select lives_ok($$insert into place_type (id, household_id, name, icon) values
  ('00000000-0000-0000-0000-00000000e781', '00000000-0000-0000-0000-0000000f78aa', '  Tool   wall ', 'wrench')$$,
  'owner adds a type of their own');
select is((select name from place_type where id = '00000000-0000-0000-0000-00000000e781'), 'Tool wall', 'its name is tidied');
select throws_ok($$insert into place_type (household_id, name) values ('00000000-0000-0000-0000-0000000f78aa', 'TOOL WALL')$$,
  '23505', null, 'names are unique per household, ignoring case');
select throws_ok($$insert into place_type (household_id, name, icon) values ('00000000-0000-0000-0000-0000000f78aa', 'Odd', 'rocket')$$,
  '23514', null, 'icons come from the fixed set');
select lives_ok($$update location set type_id = '00000000-0000-0000-0000-00000000e781', kind = null
  where id = '00000000-0000-0000-0000-00000000c782'$$, 'a place takes the type');
select lives_ok($$update place_type set name = 'Pegboard', archived = true where id = '00000000-0000-0000-0000-00000000e781'$$,
  'a type can be renamed and archived');

-- ── Owner B: nothing of A ─────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7901","role":"authenticated"}';
select is((select count(*)::int from place_type), 0, 'B sees none of A''s types');
select throws_ok($$insert into place_type (household_id, name) values ('00000000-0000-0000-0000-0000000f78aa', 'Sneaky')$$,
  '42501', null, 'B can''t add a type to A');
select throws_ok($$update location set type_id = '00000000-0000-0000-0000-00000000e781' where id = '00000000-0000-0000-0000-00000000c791'$$,
  '23503', null, 'B can''t give B''s place A''s type');
delete from place_type where id = '00000000-0000-0000-0000-00000000e781';

-- ── Viewer A ──────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7803","role":"authenticated"}';
select is((select name from place_type), 'Pegboard', 'the viewer sees A''s type, untouched by B');
select throws_ok($$insert into place_type (household_id, name) values ('00000000-0000-0000-0000-0000000f78aa', 'Viewer type')$$,
  '42501', null, 'a viewer can''t add types');

-- ── Deleting a type leaves its places untyped ─────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7801","role":"authenticated"}';
select lives_ok($$delete from place_type where id = '00000000-0000-0000-0000-00000000e781'$$, 'owner deletes the type');
select is((select type_id from location where id = '00000000-0000-0000-0000-00000000c782'), null::uuid, 'the rack is untyped, not deleted');

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from place_type$$, '42501', null, 'anon can''t read types');

select * from finish();
rollback;
