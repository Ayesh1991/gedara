-- Money master data: unit (system, read-only), category, merchant, account — household isolation,
-- viewer read-only, immutable household_id / key, two-level categories, merchant name dedupe.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7001', 'money-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7003', 'money-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8001', 'money-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f07aa', 'Money A'),
  ('00000000-0000-0000-0000-0000000f08bb', 'Money B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-0000000f7001', 'owner'),
  ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-0000000f7003', 'viewer'),
  ('00000000-0000-0000-0000-0000000f08bb', '00000000-0000-0000-0000-0000000f8001', 'owner');
insert into category (id, household_id, key, name, kind) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000f07aa', 'grocery', 'Grocery', 'expense'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000f07aa', 'income', 'Income', 'income'),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-0000000f08bb', 'grocery', 'Grocery', 'expense');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-00000000d001', 'Rice');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000f07aa', 'Cash', 'cash'),
  ('00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-0000000f08bb', 'Cash', 'cash');
insert into merchant (household_id, name) values ('00000000-0000-0000-0000-0000000f07aa', 'Cargills Food City');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7001","role":"authenticated"}';

select ok((select count(*) from unit where household_id is null) >= 11, 'members read the system units');
select throws_ok($$insert into unit (code, name, dimension, to_base) values ('x', 'x', 'other', 1)$$,
  '42501', null, 'units are read-only');

select lives_ok(
  $$insert into account (household_id, name, kind, credit_limit, last4)
    values ('00000000-0000-0000-0000-0000000f07aa', 'Seylan Credit Card', 'credit_card', 100000, '6029')$$,
  'owner can add a card');
select throws_ok(
  $$insert into account (household_id, name, kind, credit_limit) values ('00000000-0000-0000-0000-0000000f07aa', 'Wallet', 'cash', 5)$$,
  '23514', null, 'only cards and loans have a credit limit');
select throws_ok(
  $$insert into account (household_id, name, kind) values ('00000000-0000-0000-0000-0000000f07aa', ' cash ', 'cash')$$,
  '23505', null, 'account names are unique per household');
select throws_ok(
  $$update account set household_id = '00000000-0000-0000-0000-0000000f08bb' where id = '00000000-0000-0000-0000-00000000a001'$$,
  '42501', null, 'an account cannot move household');
select throws_ok(
  $$update account set is_suspense = true where id = '00000000-0000-0000-0000-00000000a001'$$,
  '42501', null, 'the suspense flag is not client-writable');

select lives_ok(
  $$insert into category (household_id, parent_id, name, kind)
    values ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-00000000d002', 'Private practice', 'expense')$$,
  'owner can add a sub-category');
select is((select kind from category where name = 'Private practice'), 'income', 'a sub-category takes its parent''s kind');
select throws_ok(
  $$insert into category (household_id, parent_id, name)
    values ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-00000000d003', 'Basmati')$$,
  '23514', null, 'only two levels');
select throws_ok(
  $$insert into category (household_id, parent_id, name)
    values ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-00000000d001', ' rice')$$,
  '23505', null, 'sibling names are unique');
select throws_ok(
  $$update category set key = 'x' where id = '00000000-0000-0000-0000-00000000d001'$$,
  '42501', null, 'category keys are not client-writable');
select throws_ok(
  $$insert into category (household_id, parent_id, name)
    values ('00000000-0000-0000-0000-0000000f07aa', '00000000-0000-0000-0000-00000000d101', 'Sneaky')$$,
  '23503', null, 'a parent must be in the same household');

select throws_ok(
  $$insert into merchant (household_id, name) values ('00000000-0000-0000-0000-0000000f07aa', '  CARGILLS   food city ')$$,
  '23505', null, 'merchant names are unique after normalising');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8001","role":"authenticated"}';

select is((select count(*)::int from account where household_id = '00000000-0000-0000-0000-0000000f07aa'), 0,
  'B cannot see A''s accounts');
select is((select count(*)::int from category where household_id = '00000000-0000-0000-0000-0000000f07aa'), 0,
  'B cannot see A''s categories');
select is((select count(*)::int from merchant where household_id = '00000000-0000-0000-0000-0000000f07aa'), 0,
  'B cannot see A''s merchants');
select throws_ok(
  $$insert into account (household_id, name, kind) values ('00000000-0000-0000-0000-0000000f07aa', 'Rogue', 'cash')$$,
  '42501', null, 'B cannot add accounts to A');
update account set name = 'Hacked' where id = '00000000-0000-0000-0000-00000000a001';
delete from category where household_id = '00000000-0000-0000-0000-0000000f07aa';

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7003","role":"authenticated"}';

select is((select name from account where id = '00000000-0000-0000-0000-00000000a001'), 'Cash',
  'viewer sees A''s account and B''s update did nothing');
select is((select count(*)::int from category where household_id = '00000000-0000-0000-0000-0000000f07aa'), 4,
  'B''s delete did nothing');
select throws_ok(
  $$insert into merchant (household_id, name) values ('00000000-0000-0000-0000-0000000f07aa', 'Keells')$$,
  '42501', null, 'viewer cannot add merchants');
update account set name = 'Viewer' where id = '00000000-0000-0000-0000-00000000a001';
select is((select name from account where id = '00000000-0000-0000-0000-00000000a001'), 'Cash',
  'viewer cannot rename accounts');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from account$$, '42501', null, 'anon has no access to accounts');
select throws_ok($$select count(*) from unit$$, '42501', null, 'anon has no access to units');

select * from finish();
rollback;
