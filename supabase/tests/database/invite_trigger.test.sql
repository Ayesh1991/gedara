-- Invite-only membership: a new auth user joins only the households that invited their email.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

insert into household (id, name) values ('00000000-0000-0000-0000-0000000000cc', 'Test C');
insert into household_invite (household_id, email, role, display_name) values
  ('00000000-0000-0000-0000-0000000000cc', 'invited@test.local', 'member', 'Invited Person'),
  ('00000000-0000-0000-0000-0000000000cc', 'late@test.local', 'viewer', null);

-- Email arrives in a different case than the invite.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000c001', 'Invited@Test.Local');

select is(
  (select role from household_member where user_id = '00000000-0000-0000-0000-00000000c001'),
  'member', 'invited user joins with the invited role (case-insensitive email)');
select is(
  (select display_name from household_member where user_id = '00000000-0000-0000-0000-00000000c001'),
  'Invited Person', 'display_name copied from the invite');
select isnt(
  (select accepted_at from household_invite where email = 'invited@test.local'),
  null, 'invite marked accepted');

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000c002', 'stranger@test.local');
select is(
  (select count(*)::int from household_member where user_id = '00000000-0000-0000-0000-00000000c002'),
  0, 'un-invited user joins nothing');

-- Backfill: user existed first, invite created later.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000c003', 'early@test.local');
insert into household_invite (household_id, email, role) values
  ('00000000-0000-0000-0000-0000000000cc', 'early@test.local', 'member');
select ok(accept_pending_invites() >= 1, 'backfill accepts invites for existing users');
select is(
  (select role from household_member where user_id = '00000000-0000-0000-0000-00000000c003'),
  'member', 'backfilled user has the invited role');

select * from finish();
rollback;
