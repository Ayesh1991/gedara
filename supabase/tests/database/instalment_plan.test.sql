-- Phase 9b.2 (migration 94): instalment plans are the household's own — members read, owners and members
-- write, viewers only read, another household neither reads nor writes; a loan needs its amount and rate.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fa901', 'plan-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa903', 'plan-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa911', 'plan-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fa9aa', 'Plans A'),
  ('00000000-0000-0000-0000-0000000fa9bb', 'Plans B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa901', 'owner'),
  ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa903', 'viewer'),
  ('00000000-0000-0000-0000-0000000fa9bb', '00000000-0000-0000-0000-0000000fa911', 'owner');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fa9a1', '00000000-0000-0000-0000-0000000fa9aa', 'People''s Card', 'credit_card', 'People''s', '1913', 1000000, 0, '2026-09-01'),
  ('00000000-0000-0000-0000-0000000fa9a2', '00000000-0000-0000-0000-0000000fa9aa', 'Loan', 'loan', 'BOC', null, 2000000, 0, '2026-10-13'),
  ('00000000-0000-0000-0000-0000000fa9b1', '00000000-0000-0000-0000-0000000fa9bb', 'Card B', 'credit_card', 'Seylan', '6029', 100000, 0, '2026-09-01');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa901","role":"authenticated"}';

select lives_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on)
  values ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa9a1', 'card', 'Luxury X', 11759.17, 24, '2025-10-30')$$,
  'the owner adds a card plan');
select lives_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on, principal, annual_rate)
  values ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa9a2', 'loan', 'BOC loan', 44488.90, 60, '2026-10-24', 2000000, 12)$$,
  'and a loan');
select throws_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on)
  values ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa9a2', 'loan', 'No rate', 1000, 12, '2026-10-24')$$,
  '23514', null, 'a loan needs its amount and rate');
select throws_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on)
  values ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa9b1', 'card', 'Wrong card', 1000, 12, '2026-10-01')$$,
  '23503', null, 'another household''s card is refused');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa903","role":"authenticated"}';
select is((select count(*)::int from instalment_plan), 2, 'a viewer reads the plans');
select throws_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on)
  values ('00000000-0000-0000-0000-0000000fa9aa', '00000000-0000-0000-0000-0000000fa9a1', 'card', 'Viewer', 1000, 12, '2026-10-01')$$,
  '42501', null, 'but cannot add one');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa911","role":"authenticated"}';
select is((select count(*)::int from instalment_plan), 0, 'another household sees none');
update instalment_plan set monthly = 1 where household_id = '00000000-0000-0000-0000-0000000fa9aa';
delete from instalment_plan where household_id = '00000000-0000-0000-0000-0000000fa9aa';

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa901","role":"authenticated"}';
select is((select string_agg(name || ':' || monthly, ',' order by name) from instalment_plan), 'BOC loan:44488.90,Luxury X:11759.17',
  'nor changes or deletes them');
select throws_ok($$insert into instalment_plan (household_id, account_id, kind, name, monthly, total_count, first_on)
  values ('00000000-0000-0000-0000-0000000fa9bb', '00000000-0000-0000-0000-0000000fa9b1', 'card', 'Theirs', 1000, 12, '2026-10-01')$$,
  '42501', null, 'and the owner cannot write into another household');

select * from finish();
rollback;
