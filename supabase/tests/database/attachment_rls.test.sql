-- attachment: household isolation, viewer read-only, one primary per entity, files stay inside
-- the household's folder, deleting a place removes its attachment rows.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f3001', 'att-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f3003', 'att-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f4001', 'att-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f03aa', 'Att A'),
  ('00000000-0000-0000-0000-0000000f04bb', 'Att B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f03aa', '00000000-0000-0000-0000-0000000f3001', 'owner'),
  ('00000000-0000-0000-0000-0000000f03aa', '00000000-0000-0000-0000-0000000f3003', 'viewer'),
  ('00000000-0000-0000-0000-0000000f04bb', '00000000-0000-0000-0000-0000000f4001', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-0000000f03aa', 'Store room');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f3001","role":"authenticated"}';

select lives_ok(
  $$insert into attachment (household_id, entity_type, entity_id, storage_path, thumb_path, mime, bytes, width, height, is_primary)
    values ('00000000-0000-0000-0000-0000000f03aa', 'location', '00000000-0000-0000-0000-00000000d0a1',
            '00000000-0000-0000-0000-0000000f03aa/location/00000000-0000-0000-0000-00000000d0a1/p.webp',
            '00000000-0000-0000-0000-0000000f03aa/location/00000000-0000-0000-0000-00000000d0a1/p.thumb.webp',
            'image/webp', 150000, 1600, 1200, true)$$,
  'owner can attach a photo');
select throws_ok(
  $$insert into attachment (household_id, entity_type, entity_id, storage_path, is_primary)
    values ('00000000-0000-0000-0000-0000000f03aa', 'location', '00000000-0000-0000-0000-00000000d0a1',
            '00000000-0000-0000-0000-0000000f03aa/location/x/q.webp', true)$$,
  '23505', null, 'only one primary photo per entity');
select throws_ok(
  $$insert into attachment (household_id, entity_type, entity_id, storage_path)
    values ('00000000-0000-0000-0000-0000000f03aa', 'location', '00000000-0000-0000-0000-00000000d0a1',
            '00000000-0000-0000-0000-0000000f04bb/location/x/q.webp')$$,
  '23514', null, 'files must live in the household''s own folder');
select throws_ok(
  $$update attachment set household_id = '00000000-0000-0000-0000-0000000f04bb'$$,
  '42501', null, 'attachments cannot change household');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f4001","role":"authenticated"}';

select is((select count(*)::int from attachment where household_id = '00000000-0000-0000-0000-0000000f03aa'), 0,
  'B cannot see A''s attachments');
select throws_ok(
  $$insert into attachment (household_id, entity_type, entity_id, storage_path)
    values ('00000000-0000-0000-0000-0000000f03aa', 'location', '00000000-0000-0000-0000-00000000d0a1',
            '00000000-0000-0000-0000-0000000f03aa/location/x/evil.webp')$$,
  '42501', null, 'B cannot attach files to A');
delete from attachment where household_id = '00000000-0000-0000-0000-0000000f03aa';

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f3003","role":"authenticated"}';

select is((select count(*)::int from attachment where household_id = '00000000-0000-0000-0000-0000000f03aa'), 1,
  'viewer sees A''s attachments (and B''s delete did nothing)');
select throws_ok(
  $$insert into attachment (household_id, entity_type, entity_id, storage_path)
    values ('00000000-0000-0000-0000-0000000f03aa', 'location', '00000000-0000-0000-0000-00000000d0a1',
            '00000000-0000-0000-0000-0000000f03aa/location/x/v.webp')$$,
  '42501', null, 'viewer cannot attach files');
delete from attachment where household_id = '00000000-0000-0000-0000-0000000f03aa';
select is((select count(*)::int from attachment where household_id = '00000000-0000-0000-0000-0000000f03aa'), 1,
  'viewer cannot delete attachments');

-- ── Owner of A deletes the place ──────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f3001","role":"authenticated"}';
delete from location where id = '00000000-0000-0000-0000-00000000d0a1';
select is((select count(*)::int from attachment where entity_id = '00000000-0000-0000-0000-00000000d0a1'), 0,
  'deleting a place removes its attachment rows');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from attachment$$, '42501', null, 'anon has no access to attachment');

select * from finish();
rollback;
