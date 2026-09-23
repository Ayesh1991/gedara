-- Storage RLS: files live under {household_id}/…; only that household's members can touch them.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d001', 'owner-d@test.local'),
  ('00000000-0000-0000-0000-00000000d002', 'viewer-d@test.local'),
  ('00000000-0000-0000-0000-00000000e001', 'owner-e@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000000dd', 'Test D'),
  ('00000000-0000-0000-0000-0000000000ee', 'Test E');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000dd', '00000000-0000-0000-0000-00000000d001', 'owner'),
  ('00000000-0000-0000-0000-0000000000dd', '00000000-0000-0000-0000-00000000d002', 'viewer'),
  ('00000000-0000-0000-0000-0000000000ee', '00000000-0000-0000-0000-00000000e001', 'owner');

-- A file owned by household D (inserted as the migration owner)
insert into storage.objects (bucket_id, name)
values ('household-files', '00000000-0000-0000-0000-0000000000dd/location/x/photo.webp');

set local role authenticated;

-- Owner of D
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'household-files'), 1,
  'owner of D sees D''s file');
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('household-files', '00000000-0000-0000-0000-0000000000dd/location/x/second.webp')$$,
  'owner of D can upload under D/');

-- Viewer of D
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}';
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('household-files', '00000000-0000-0000-0000-0000000000dd/location/x/viewer.webp')$$,
  '42501', null, 'viewer of D cannot upload');

-- Owner of E
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'household-files'
             and name like '00000000-0000-0000-0000-0000000000dd/%'), 0,
  'E cannot see D''s files');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('household-files', '00000000-0000-0000-0000-0000000000dd/location/x/evil.webp')$$,
  '42501', null, 'E cannot upload under D/');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('household-files', 'not-a-uuid/evil.webp')$$,
  '42501', null, 'malformed path is denied, not an error');

select * from finish();
rollback;
