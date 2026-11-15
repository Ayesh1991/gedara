-- v0.13.0 · 115: "Used" for things (status used + gone_on / gone_note), its history, value 0, no
-- attention for used things, Ask leaves them out; another household can't read or write the new
-- columns; viewers can't mark a thing used; photo-by-scan: attachment is in the Realtime
-- publication and a member still can't add a photo to a valuable thing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f1501', 'used-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f1502', 'used-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f1503', 'used-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f1504', 'used-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f15aa', 'Used A'),
  ('00000000-0000-0000-0000-0000000f15bb', 'Used B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f15aa', '00000000-0000-0000-0000-0000000f1501', 'owner'),
  ('00000000-0000-0000-0000-0000000f15aa', '00000000-0000-0000-0000-0000000f1502', 'member'),
  ('00000000-0000-0000-0000-0000000f15aa', '00000000-0000-0000-0000-0000000f1503', 'viewer'),
  ('00000000-0000-0000-0000-0000000f15bb', '00000000-0000-0000-0000-0000000f1504', 'owner');
insert into asset (id, household_id, name, purchase_price, purchased_on, useful_life_months, warranty_until) values
  ('00000000-0000-0000-0000-0000000f15a1', '00000000-0000-0000-0000-0000000f15aa', 'Wood screws', 900, current_date - 60, 120, current_date + 10),
  ('00000000-0000-0000-0000-0000000f15a2', '00000000-0000-0000-0000-0000000f15aa', 'Hinges', 400, current_date - 30, null, null),
  ('00000000-0000-0000-0000-0000000f15b1', '00000000-0000-0000-0000-0000000f15bb', 'Nails B', 100, current_date - 30, null, null);
insert into asset (id, household_id, name, valuable) values
  ('00000000-0000-0000-0000-0000000f15a3', '00000000-0000-0000-0000-0000000f15aa', 'Gold chain', true);
insert into maintenance_plan (id, household_id, asset_id, name, every_days) values
  ('00000000-0000-0000-0000-0000000f15c1', '00000000-0000-0000-0000-0000000f15aa', '00000000-0000-0000-0000-0000000f15a1', 'Check', 7);

-- Before: the screws have a warranty alert.
select ok(exists (select 1 from private.attention_items('00000000-0000-0000-0000-0000000f15aa')
                   where kind = 'warranty_ending' and entity_id = '00000000-0000-0000-0000-0000000f15a1'),
  'an active thing has its warranty alert');

select ok(exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attachment'),
  'attachment is in the Realtime publication (photo-by-scan updates the PC)');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1501","role":"authenticated"}';

select throws_ok($$update asset set status = 'used', gone_on = current_date + 400
  where id = '00000000-0000-0000-0000-0000000f15a1'$$, 'GDGON', null, 'a used day in the future is refused');
select throws_ok($$update asset set status = 'used', gone_on = current_date - 90
  where id = '00000000-0000-0000-0000-0000000f15a1'$$, 'GDGON', null, 'a used day before it was bought is refused');
select lives_ok($$update asset set status = 'used', gone_on = current_date - 5, gone_note = '  Book rack  '
  where id = '00000000-0000-0000-0000-0000000f15a1'$$, 'owner marks the screws used, with a note');
select is((select status || '|' || gone_on || '|' || gone_note from asset where id = '00000000-0000-0000-0000-0000000f15a1'),
  'used|' || (current_date - 5) || '|Book rack', 'status, day and the tidied note are kept');
select is((select current_value from v_asset where id = '00000000-0000-0000-0000-0000000f15a1'),
  0::numeric, 'a used thing is worth 0');
select is((select gone_on from v_asset where id = '00000000-0000-0000-0000-0000000f15a1'),
  current_date - 5, 'v_asset shows the day it was used');
select is((select months_owned from v_asset where id = '00000000-0000-0000-0000-0000000f15a1'),
  (select (extract(year from age(current_date - 5, current_date - 60)) * 12
         + extract(month from age(current_date - 5, current_date - 60)))::integer),
  'months owned stop on the day it was used');
select is((select verb || '|' || summary || '|' || (payload ->> 'gone_on') from activity
            where entity_id = '00000000-0000-0000-0000-0000000f15a1' and verb = 'used'),
  'used|Book rack|' || (current_date - 5), 'history records "used" with the day and the note');

select lives_ok($$update asset set status = 'used' where id = '00000000-0000-0000-0000-0000000f15a2'$$,
  'marking used without a day');
select is((select gone_on from asset where id = '00000000-0000-0000-0000-0000000f15a2'),
  (now() at time zone 'Asia/Colombo')::date, 'the day defaults to today in the household''s time zone');

select ok(not coalesce((ask_find('00000000-0000-0000-0000-0000000f15aa', 'wood screws') -> 'rows')::text ilike '%Wood screws%', false),
  'Ask leaves used things out');

-- Bring back
select lives_ok($$update asset set status = 'in_use' where id = '00000000-0000-0000-0000-0000000f15a2'$$,
  'owner brings the hinges back');
select is((select coalesce(gone_on::text, 'null') || '|' || coalesce(gone_note, 'null') from asset
            where id = '00000000-0000-0000-0000-0000000f15a2'),
  'null|null', 'bringing back clears the day and the note');
select is((select count(*)::int from activity where entity_id = '00000000-0000-0000-0000-0000000f15a2' and verb = 'unused'),
  1, 'history records "brought back"');
select lives_ok($$update asset set status = 'disposed', gone_on = current_date, gone_note = 'gave to cousin'
  where id = '00000000-0000-0000-0000-0000000f15a2'$$, 'disposed may carry a day and a note too');
select lives_ok($$update asset set status = 'stored' where id = '00000000-0000-0000-0000-0000000f15a2'$$, 'back to stored');
select is((select gone_on from asset where id = '00000000-0000-0000-0000-0000000f15a2'), null::date,
  'an active status clears the day');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1503","role":"authenticated"}';
select is((select gone_note from asset where id = '00000000-0000-0000-0000-0000000f15a1'), 'Book rack',
  'a viewer can read the note');
update asset set status = 'used' where id = '00000000-0000-0000-0000-0000000f15a2';
reset role;
select is((select status from asset where id = '00000000-0000-0000-0000-0000000f15a2'), 'stored',
  'a viewer can''t mark a thing used');
set local role authenticated;

-- ── Member of A: valuable thing's photos stay owner-only ──────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1502","role":"authenticated"}';
select throws_ok($$insert into attachment (household_id, entity_type, entity_id, storage_path, is_primary)
    values ('00000000-0000-0000-0000-0000000f15aa', 'asset', '00000000-0000-0000-0000-0000000f15a3',
            '00000000-0000-0000-0000-0000000f15aa/asset/00000000-0000-0000-0000-0000000f15a3/p.webp', true)$$,
  '42501', null, 'a member can''t add a photo to a valuable thing');
select lives_ok($$insert into attachment (household_id, entity_type, entity_id, storage_path, is_primary)
    values ('00000000-0000-0000-0000-0000000f15aa', 'asset', '00000000-0000-0000-0000-0000000f15a1',
            '00000000-0000-0000-0000-0000000f15aa/asset/00000000-0000-0000-0000-0000000f15a1/p.webp', true)$$,
  'a member can add a photo to an ordinary thing');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f1504","role":"authenticated"}';
select is((select count(*)::int from asset where gone_note is not null or gone_on is not null), 0,
  'another household can''t read the day or the note');
update asset set status = 'in_use', gone_note = 'hacked' where id = '00000000-0000-0000-0000-0000000f15a1';
select throws_ok($$insert into asset (household_id, name, status, gone_on)
    values ('00000000-0000-0000-0000-0000000f15aa', 'Sneaky', 'used', current_date)$$,
  '42501', null, 'another household can''t add a used thing');

reset role;
select is((select status || '|' || gone_note from asset where id = '00000000-0000-0000-0000-0000000f15a1'),
  'used|Book rack', 'another household can''t change it');
select ok(not exists (select 1 from private.attention_items('00000000-0000-0000-0000-0000000f15aa')
                       where entity_id = '00000000-0000-0000-0000-0000000f15a1'
                         and kind in ('warranty_ending', 'service_due')),
  'a used thing has no warranty or service alerts');

select * from finish();
rollback;
