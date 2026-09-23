-- Tenancy RLS: another household can't read or write ours; viewers can't write; anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

-- RLS helpers live in the non-exposed private schema (not callable via /rest/v1/rpc)
select hasnt_function('public', 'is_member', array['uuid'], 'is_member is not in the API schema');
select has_function('private', 'is_member', array['uuid'], 'is_member lives in private');

-- Fixtures (as the migration owner; rolled back at the end)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-00000000a002', 'member-a@test.local'),
  ('00000000-0000-0000-0000-00000000a003', 'viewer-a@test.local'),
  ('00000000-0000-0000-0000-00000000b001', 'owner-b@test.local');

insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000000aa', 'Test A'),
  ('00000000-0000-0000-0000-0000000000bb', 'Test B');

insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a001', 'owner'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a002', 'member'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a003', 'viewer'),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-00000000b001', 'owner');

insert into household_invite (household_id, email, role) values
  ('00000000-0000-0000-0000-0000000000aa', 'pending-a@test.local', 'member'),
  ('00000000-0000-0000-0000-0000000000bb', 'pending-b@test.local', 'member');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000b001","role":"authenticated"}';

select is((select count(*)::int from household where id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'B cannot see household A');
select is((select count(*)::int from household_member where household_id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'B cannot see A''s members');
select is((select count(*)::int from household_invite where household_id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'B cannot see A''s invites');
select is((select count(*)::int from household), 1,
  'B sees exactly its own household');
select ok(not private.is_member('00000000-0000-0000-0000-0000000000aa'), 'private.is_member(A) is false for B');

update household set name = 'hacked' where id = '00000000-0000-0000-0000-0000000000aa';
select is((select count(*)::int from household where name = 'hacked'), 0, 'B cannot rename household A');

select throws_ok(
  $$insert into household_member (household_id, user_id, role)
    values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000b001', 'owner')$$,
  '42501', null, 'B cannot add itself to household A');

select throws_ok(
  $$insert into household (name) values ('rogue')$$,
  '42501', null, 'clients cannot create households');

-- ── Member of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a002","role":"authenticated"}';

select is((select count(*)::int from household_member where household_id = '00000000-0000-0000-0000-0000000000aa'), 3,
  'member of A sees all A members');
select is((select count(*)::int from household_invite), 0, 'non-owner cannot read invites');
update household set name = 'renamed by member' where id = '00000000-0000-0000-0000-0000000000aa';
select is((select name from household where id = '00000000-0000-0000-0000-0000000000aa'), 'Test A',
  'only owners may update the household');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a003","role":"authenticated"}';
select ok(private.is_member('00000000-0000-0000-0000-0000000000aa'), 'viewer is a member');
select ok(not private.can_write('00000000-0000-0000-0000-0000000000aa'), 'viewer cannot write');

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
select is((select count(*)::int from household_invite), 1, 'owner of A sees only A''s invites');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from household$$, '42501', null, 'anon has no access to household');
select throws_ok($$select count(*) from household_member$$, '42501', null, 'anon has no access to household_member');
select throws_ok($$select private.is_member('00000000-0000-0000-0000-0000000000aa')$$, '42501', null, 'anon cannot call the RLS helpers');

select * from finish();
rollback;
