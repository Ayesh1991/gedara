-- label_profile: household isolation, viewer read-only, sane ranges, one profile per name.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f5001', 'lbl-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f5003', 'lbl-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6001', 'lbl-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f05aa', 'Lbl A'),
  ('00000000-0000-0000-0000-0000000f06bb', 'Lbl B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f05aa', '00000000-0000-0000-0000-0000000f5001', 'owner'),
  ('00000000-0000-0000-0000-0000000f05aa', '00000000-0000-0000-0000-0000000f5003', 'viewer'),
  ('00000000-0000-0000-0000-0000000f06bb', '00000000-0000-0000-0000-0000000f6001', 'owner');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5001","role":"authenticated"}';

select lives_ok(
  $$insert into label_profile (household_id, name, offset_x, offset_y)
    values ('00000000-0000-0000-0000-0000000f05aa', 'Epson L3110', 0.5, -1.0)$$,
  'owner can save a printer profile');
select throws_ok(
  $$insert into label_profile (household_id, name) values ('00000000-0000-0000-0000-0000000f05aa', 'Epson L3110')$$,
  '23505', null, 'one profile per name');
select throws_ok(
  $$update label_profile set offset_x = 45 where household_id = '00000000-0000-0000-0000-0000000f05aa'$$,
  '23514', null, 'offsets are range-checked');
update label_profile set offset_x = 1.5 where household_id = '00000000-0000-0000-0000-0000000f05aa';
select is((select offset_x from label_profile where household_id = '00000000-0000-0000-0000-0000000f05aa'), 1.50::numeric,
  'owner can nudge the calibration');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6001","role":"authenticated"}';

select is((select count(*)::int from label_profile where household_id = '00000000-0000-0000-0000-0000000f05aa'), 0,
  'B cannot see A''s profiles');
select throws_ok(
  $$insert into label_profile (household_id, name) values ('00000000-0000-0000-0000-0000000f05aa', 'rogue')$$,
  '42501', null, 'B cannot add profiles to A');
update label_profile set offset_x = 9 where household_id = '00000000-0000-0000-0000-0000000f05aa';

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f5003","role":"authenticated"}';

select is((select offset_x from label_profile where household_id = '00000000-0000-0000-0000-0000000f05aa'), 1.50::numeric,
  'viewer sees A''s profile (and B''s update did nothing)');
select throws_ok(
  $$insert into label_profile (household_id, name) values ('00000000-0000-0000-0000-0000000f05aa', 'viewer')$$,
  '42501', null, 'viewer cannot add profiles');
update label_profile set offset_x = 3 where household_id = '00000000-0000-0000-0000-0000000f05aa';
select is((select offset_x from label_profile where household_id = '00000000-0000-0000-0000-0000000f05aa'), 1.50::numeric,
  'viewer cannot change the calibration');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from label_profile$$, '42501', null, 'anon has no access to label_profile');

select * from finish();
rollback;
