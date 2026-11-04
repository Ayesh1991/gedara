-- Migration 104: deleting an account forgets the shop memories that only knew that account (they used to
-- become (null, null) through ON DELETE SET NULL and fail merchant_memory_check), keeps the category of
-- the others, and never touches another household's memories.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fd101', 'mmad-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fe101', 'mmad-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fd1aa', 'MMAD A'),
  ('00000000-0000-0000-0000-0000000fe1bb', 'MMAD B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd101', 'owner'),
  ('00000000-0000-0000-0000-0000000fe1bb', '00000000-0000-0000-0000-0000000fe101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fd0c1', '00000000-0000-0000-0000-0000000fd1aa', 'groceries', 'Groceries', 'expense');
insert into account (id, household_id, name, kind, opening_balance) values
  ('00000000-0000-0000-0000-0000000fd0a1', '00000000-0000-0000-0000-0000000fd1aa', 'MMAD Card', 'cash', 0),
  ('00000000-0000-0000-0000-0000000fd0a2', '00000000-0000-0000-0000-0000000fd1aa', 'MMAD Wallet', 'cash', 0),
  ('00000000-0000-0000-0000-0000000fe0a1', '00000000-0000-0000-0000-0000000fe1bb', 'MMAD B Cash', 'cash', 0);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';
select is(rpc_memory_learn('00000000-0000-0000-0000-0000000fd1aa', '[
  {"kind":"merchant","text":"Card Only Shop","account_id":"00000000-0000-0000-0000-0000000fd0a1"},
  {"kind":"merchant","text":"Both Shop","category_id":"00000000-0000-0000-0000-0000000fd0c1","account_id":"00000000-0000-0000-0000-0000000fd0a1"},
  {"kind":"merchant","text":"Wallet Shop","account_id":"00000000-0000-0000-0000-0000000fd0a2"}]'::jsonb), 3,
  'A learns three shop memories, two with only an account');

-- The cleanup / admin path (service role, as the e2e afterAll does). B's account first: A is untouched.
reset role;
select lives_ok($$delete from account where id = '00000000-0000-0000-0000-0000000fe0a1'$$,
  'another household''s account can be deleted');
select is((select count(*)::int from merchant_memory where household_id = '00000000-0000-0000-0000-0000000fd1aa'), 3,
  'it leaves A''s memories alone');

-- Now A's card.
select lives_ok($$delete from account where id = '00000000-0000-0000-0000-0000000fd0a1'$$,
  'an account whose only memory of a shop is that account can be deleted (was 23514 merchant_memory_check)');
select is((select count(*)::int from merchant_memory where merchant_norm = 'card only shop'), 0,
  'the account-only memory is forgotten');
select is((select (category_id is not null) || ' ' || (account_id is null) from merchant_memory where merchant_norm = 'both shop'),
  'true true', 'a memory with a category keeps it; only the account is cleared');
select is((select account_id from merchant_memory where merchant_norm = 'wallet shop'),
  '00000000-0000-0000-0000-0000000fd0a2'::uuid, 'a memory of another account is untouched');

select is(has_function_privilege('authenticated', 'private.account_forget_merchant_memory()', 'execute'), false,
  'the trigger function can''t be called directly');

select * from finish();
rollback;
