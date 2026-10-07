-- Phase 6b RLS: another household can't read or change my scales, their tokens, my container tags,
-- readings, commands or firmware, can't weigh, link, command, decide or arm my jars, and a scale
-- with B's token can't see A's tags. Token hashes are unreadable to everyone but SECURITY DEFINER
-- code; only the owner adds or revokes a scale; a member may rename, set sound and calibrate but not
-- reboot or update; a viewer only reads; the device RPC is for the service role only; anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(47);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f6b01', 'p6brls-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6b02', 'p6brls-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6b03', 'p6brls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6c01', 'p6brls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f6baa', 'Scale RLS A'),
  ('00000000-0000-0000-0000-0000000f6cbb', 'Scale RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f6baa', '00000000-0000-0000-0000-0000000f6b01', 'owner'),
  ('00000000-0000-0000-0000-0000000f6baa', '00000000-0000-0000-0000-0000000f6b02', 'member'),
  ('00000000-0000-0000-0000-0000000f6baa', '00000000-0000-0000-0000-0000000f6b03', 'viewer'),
  ('00000000-0000-0000-0000-0000000f6cbb', '00000000-0000-0000-0000-0000000f6c01', 'owner');
insert into product (id, household_id, name, stock_unit_id) values
  ('00000000-0000-0000-0000-00000000d6b1', '00000000-0000-0000-0000-0000000f6baa', 'Sugar A', pg_temp.u('g')),
  ('00000000-0000-0000-0000-00000000d6c1', '00000000-0000-0000-0000-0000000f6cbb', 'Sugar B', pg_temp.u('g'));
insert into location (id, household_id, name, kind, holds_product_id, tare_g) values
  ('00000000-0000-0000-0000-00000000c6b1', '00000000-0000-0000-0000-0000000f6baa', 'Jar A', 'container',
   '00000000-0000-0000-0000-00000000d6b1', 400),
  ('00000000-0000-0000-0000-00000000c6c1', '00000000-0000-0000-0000-0000000f6cbb', 'Jar B', 'container',
   '00000000-0000-0000-0000-00000000d6c1', 400);
-- A file in A's firmware folder (as the migration owner).
insert into storage.objects (bucket_id, name, metadata) values
  ('device-firmware', '00000000-0000-0000-0000-0000000f6baa/scale/0.1.0.bin', '{"size": 100000}');

set local role authenticated;

-- ── Owner A: a scale, a tag, a reading, a firmware ────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6b01","role":"authenticated"}';
insert into t_c values ('dev', rpc_device_create('00000000-0000-0000-0000-0000000f6baa', 'Scale A'));
select is(length((select v ->> 'token' from t_c where k = 'dev')), 43, 'the token is shown once, 43 characters');
select is((select count(*)::int from device), 1, 'owner sees the scale');
select is((select token_hint from device), right((select v ->> 'token' from t_c where k = 'dev'), 4), 'only a hint is kept in view');
select throws_ok($$select count(*) from device_token$$, '42501', null, 'token hashes can''t be read');
select throws_ok($$insert into device (household_id, name, token_hint) values ('00000000-0000-0000-0000-0000000f6baa', 'x', 'abcd')$$,
  '42501', null, 'scales are added by rpc_device_create only');
select throws_ok($$update device set name = 'x'$$, '42501', null, 'scales change through rpc_device_update only');
select lives_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6b1', '04:a1:b2:c3:d4:e5:f6')$$, 'owner links a tag to the jar');
select throws_ok($$insert into nfc_tag (household_id, uid, location_id) values
  ('00000000-0000-0000-0000-0000000f6baa', '04A1B2C3D4E5F7', '00000000-0000-0000-0000-00000000c6b1')$$,
  '42501', null, 'tags are linked by RPC only');
insert into t_c values ('w', rpc_weigh('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-00000000c6b1', 0));
select throws_ok($$insert into scale_reading (household_id, op_id, at, status, result) values
  ('00000000-0000-0000-0000-0000000f6baa', gen_random_uuid(), now(), 'no_change', '{}')$$, '42501', null, 'readings are written by RPCs only');
select throws_ok($$insert into device_command (household_id, device_id, command) values
  ('00000000-0000-0000-0000-0000000f6baa', (select id from device), 'beep')$$, '42501', null, 'commands are queued by RPC only');
select lives_ok($$select rpc_device_firmware_add('00000000-0000-0000-0000-0000000f6baa', jsonb_build_object(
  'path', '00000000-0000-0000-0000-0000000f6baa/scale/0.1.0.bin', 'version', '0.1.0', 'project', 'gedara-kitchen-scale',
  'sha256', repeat('a', 64), 'size', 100000))$$, 'owner registers an uploaded firmware');
select throws_ok($$insert into device_firmware (household_id, version, project, sha256, size, path) values
  ('00000000-0000-0000-0000-0000000f6baa', '9.9.9', 'gedara-kitchen-scale', repeat('b', 64), 100000, 'x')$$,
  '42501', null, 'firmware rows come from rpc_device_firmware_add only');
select throws_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6c1', '04A1B2C3D4E5F8')$$,
  '42501', null, 'A can''t tag B''s jar');
select throws_ok($$update location set holds_product_id = '00000000-0000-0000-0000-00000000d6c1'
  where id = '00000000-0000-0000-0000-00000000c6b1'$$, '23503', null, 'A''s jar can''t hold B''s product');

-- ── Member A: settings and calibration yes; adding, removing, reboot, update no ─
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6b02","role":"authenticated"}';
select throws_ok($$select rpc_device_create('00000000-0000-0000-0000-0000000f6baa', 'Scale 2')$$, '42501', null,
  'a member can''t add a scale');
select lives_ok($$select rpc_device_update((select id from device), '{"settings":{"volume":30}}')$$, 'a member sets the volume');
select lives_ok($$select rpc_device_command((select id from device), 'calibrate', '{"known_g":1000}')$$, 'a member calibrates');
select throws_ok($$select rpc_device_command((select id from device), 'reboot')$$, '42501', null, 'a member can''t reboot');
select throws_ok($$select rpc_device_command((select id from device), 'ota',
  jsonb_build_object('firmware_id', (select id from device_firmware)))$$, '42501', null, 'a member can''t start an update');
select throws_ok($$select rpc_device_revoke((select id from device))$$, '42501', null, 'a member can''t remove a scale');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('device-firmware', '00000000-0000-0000-0000-0000000f6baa/scale/0.2.0.bin')$$, '42501', null, 'a member can''t upload firmware');

-- ── Owner B: nothing of A ─────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6c01","role":"authenticated"}';
insert into t_c values ('devb', rpc_device_create('00000000-0000-0000-0000-0000000f6cbb', 'Scale B'));
select is((select count(*)::int from device), 1, 'B sees only B''s scale');
select is((select count(*)::int from nfc_tag) + (select count(*)::int from scale_reading)
        + (select count(*)::int from device_command) + (select count(*)::int from device_firmware), 0,
  'B sees none of A''s tags, readings, commands or firmware');
select is((select count(*)::int from storage.objects where bucket_id = 'device-firmware'), 0, 'B can''t see A''s firmware file');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('device-firmware', '00000000-0000-0000-0000-0000000f6baa/scale/0.3.0.bin')$$, '42501', null, 'B can''t upload into A''s folder');
select throws_ok($$select rpc_device_create('00000000-0000-0000-0000-0000000f6baa', 'Spy')$$, '42501', null, 'B can''t add a scale to A');
select throws_ok(format($$select rpc_device_update(%L, '{"name":"x"}')$$, (select v ->> 'id' from t_c where k = 'dev')),
  '42501', null, 'B can''t rename A''s scale');
select throws_ok(format($$select rpc_device_revoke(%L)$$, (select v ->> 'id' from t_c where k = 'dev')),
  '42501', null, 'B can''t remove A''s scale');
select throws_ok(format($$select rpc_device_command(%L, 'beep')$$, (select v ->> 'id' from t_c where k = 'dev')),
  '42501', null, 'B can''t command A''s scale');
select throws_ok(format($$select rpc_device_watch(%L)$$, (select v ->> 'id' from t_c where k = 'dev')),
  '42501', null, 'B can''t watch A''s scale');
select throws_ok($$select rpc_weigh(gen_random_uuid(), '00000000-0000-0000-0000-00000000c6b1', 100)$$, '42501', null,
  'B can''t weigh A''s jar');
select throws_ok($$select rpc_container_setup('00000000-0000-0000-0000-00000000c6b1')$$, '42501', null, 'B can''t arm A''s jar');
select throws_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6b1', '04A1B2C3D4E5F9')$$, '42501', null,
  'B can''t tag A''s jar');
select throws_ok($$select rpc_device_firmware_add('00000000-0000-0000-0000-0000000f6baa', '{}')$$, '42501', null,
  'B can''t register firmware for A');
update location set tare_g = 1 where id = '00000000-0000-0000-0000-00000000c6b1';
select throws_ok($$select rpc_scale_sync(repeat('0', 64), '{}')$$, '42501', null, 'users can''t call the device RPC');

-- ── Viewer A: reads only ──────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6b03","role":"authenticated"}';
select is((select tare_g from location where id = '00000000-0000-0000-0000-00000000c6b1'), 400::numeric(14,4),
  'A''s empty weight is untouched by B');
select is((select count(*)::int from scale_reading), 1, 'the viewer sees the reading');
select throws_ok($$select rpc_weigh(gen_random_uuid(), '00000000-0000-0000-0000-00000000c6b1', 100)$$, '42501', null,
  'a viewer can''t weigh');
select throws_ok($$select rpc_device_command((select id from device), 'beep')$$, '42501', null, 'a viewer can''t beep');
select throws_ok($$select rpc_nfc_tag_unlink((select id from nfc_tag))$$, '42501', null, 'a viewer can''t unlink a tag');

-- ── The Edge Function (service role): B's scale can't see A's tag ─────────────
reset role;
set local role service_role;
insert into t_c values ('syncb', rpc_scale_sync(
  encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = 'devb'), 'UTF8'), 'sha256'), 'hex'),
  '{"v":1,"fw":"0.1.0","epoch":1,"boot":1,"up":5000,
    "events":[{"seq":1,"b":1,"t":4000,"type":"weigh","uid":"04A1B2C3D4E5F6","gross_g":900}]}'));
select is((select v -> 'results' -> 0 ->> 'status' from t_c where k = 'syncb'), 'unknown_tag', 'A''s tag is unknown to B''s scale');
select is((select v -> 'containers' -> 'items' from t_c where k = 'syncb'), '[]'::jsonb, 'B''s scale gets none of A''s containers');
select is((select count(*)::int from scale_reading where household_id = '00000000-0000-0000-0000-0000000f6baa'), 1,
  'nothing was written to A');
select throws_ok($$select rpc_scale_sync(repeat('0', 64), '{"v":1,"epoch":1,"boot":1,"up":1}')$$, '42501', null,
  'an unknown token is refused');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from device$$, '42501', null, 'anon can''t read scales');
select throws_ok($$select count(*) from scale_reading$$, '42501', null, 'anon can''t read readings');
select throws_ok($$select rpc_scale_sync(repeat('0', 64), '{}')$$, '42501', null, 'anon can''t call the device RPC');

select * from finish();
rollback;
