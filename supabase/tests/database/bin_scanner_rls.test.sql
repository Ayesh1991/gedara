-- Phase 11 RLS: another household can't read or change my scanners, their keys or my scans, can't
-- undo, resolve, pause, resume or settle them, and a scanner with B's key never touches A's stock,
-- even for a barcode only A knows. Key hashes are unreadable to everyone but SECURITY DEFINER code;
-- scans are written by the RPCs only; only the owner adds, removes, resumes, reboots or updates a
-- scanner; a member may pause it and undo scans; a viewer only reads; the device RPC is for the
-- service role only; anon sees nothing; firmware is per kind of device.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f11b01', 'p11rls-owner-a@test.local'),
  ('00000000-0000-0000-0000-000000f11b02', 'p11rls-member-a@test.local'),
  ('00000000-0000-0000-0000-000000f11b03', 'p11rls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-000000f11c01', 'p11rls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-000000f11baa', 'Bin RLS A'),
  ('00000000-0000-0000-0000-000000f11cbb', 'Bin RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-000000f11baa', '00000000-0000-0000-0000-000000f11b01', 'owner'),
  ('00000000-0000-0000-0000-000000f11baa', '00000000-0000-0000-0000-000000f11b02', 'member'),
  ('00000000-0000-0000-0000-000000f11baa', '00000000-0000-0000-0000-000000f11b03', 'viewer'),
  ('00000000-0000-0000-0000-000000f11cbb', '00000000-0000-0000-0000-000000f11c01', 'owner');
insert into product (id, household_id, name, stock_unit_id) values
  ('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000f11baa', 'Yoghurt A', pg_temp.u('pcs'));
-- Files in A's firmware folders (as the migration owner).
insert into storage.objects (bucket_id, name, metadata) values
  ('device-firmware', '00000000-0000-0000-0000-000000f11baa/scanner/0.1.0.bin', '{"size": 100000}'),
  ('device-firmware', '00000000-0000-0000-0000-000000f11baa/scale/0.9.0.bin', '{"size": 100000}');

create function pg_temp.hash(p_k text) returns text language sql stable as
  $$ select encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = p_k), 'UTF8'), 'sha256'), 'hex') $$;
create function pg_temp.dev(p_k text) returns uuid language sql stable as
  $$ select (v ->> 'id')::uuid from t_c where k = p_k $$;
create function pg_temp.scan(p_k text, p_seq int, p_mode text, p_code text) returns jsonb language sql volatile as
  $$ select public.rpc_scanner_sync(pg_temp.hash(p_k), jsonb_build_object('v', 1, 'fw', '0.1.0', 'epoch', 9, 'boot', 1, 'up', 5000,
       'events', jsonb_build_array(jsonb_build_object('seq', p_seq, 'b', 1, 't', 5000, 'type', 'scan', 'mode', p_mode, 'code', p_code)))) $$;
create function pg_temp.row(p_seq int) returns uuid language sql stable security definer as
  $$ select id from public.bin_scan where household_id = '00000000-0000-0000-0000-000000f11baa' and seq = p_seq $$;
create function pg_temp.lft() returns numeric language sql stable security definer as
  $$ select coalesce(sum(qty_remaining), 0) from public.stock_lot where product_id = '00000000-0000-0000-0000-000000d11b01' $$;

set local role authenticated;

-- ── Owner A: a scanner, a barcode, stock ──────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000f11b01","role":"authenticated"}';
insert into t_c values ('a', rpc_scanner_create('00000000-0000-0000-0000-000000f11baa', 'Scanner A'));
select is((select count(*)::int from device where kind = 'scanner'), 1, 'owner sees the scanner');
select is((select token_hint from device where kind = 'scanner'), right((select v ->> 'token' from t_c where k = 'a'), 4), 'only a hint of the key is kept in view');
select throws_ok($$select count(*) from scanner_token$$, '42501', null, 'key hashes can''t be read');
select throws_ok($$insert into device (household_id, kind, name, token_hint) values ('00000000-0000-0000-0000-000000f11baa', 'scanner', 'x', 'abcd')$$,
  '42501', null, 'scanners are added by rpc_scanner_create only');
insert into product_barcode (household_id, product_id, barcode) values
  ('00000000-0000-0000-0000-000000f11baa', '00000000-0000-0000-0000-000000d11b01', '4791111111116');
insert into t_c values ('p', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11baa","product_id":"00000000-0000-0000-0000-000000d11b01","qty":6}'));
select throws_ok($$select rpc_scanner_sync('x', '{}')$$, '42501', null, 'a person can''t call the scanner''s RPC');
select lives_ok($$select rpc_device_firmware_add('00000000-0000-0000-0000-000000f11baa', '{"path":"00000000-0000-0000-0000-000000f11baa/scanner/0.1.0.bin",
  "size":100000,"version":"0.1.0","project":"gedara-bin-scanner","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,
  'owner registers scanner firmware');
select throws_ok($$select rpc_device_firmware_add('00000000-0000-0000-0000-000000f11baa', '{"path":"00000000-0000-0000-0000-000000f11baa/scale/0.9.0.bin",
  "size":100000,"version":"0.9.0","project":"gedara-bin-scanner","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}')$$,
  '23514', null, 'scanner firmware can''t be filed as scale firmware');
select lives_ok($$select rpc_device_firmware_add('00000000-0000-0000-0000-000000f11baa', '{"path":"00000000-0000-0000-0000-000000f11baa/scale/0.9.0.bin",
  "size":100000,"version":"0.9.0","project":"gedara-kitchen-scale","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}')$$,
  'scale firmware still registers');
select throws_ok(format($$select rpc_device_command(%L, 'ota', jsonb_build_object('firmware_id', (select id from device_firmware where kind = 'scale')))$$, pg_temp.dev('a')),
  '23503', null, 'a scanner can''t be given scale firmware');
select lives_ok(format($$select rpc_device_command(%L, 'ota', jsonb_build_object('firmware_id', (select id from device_firmware where kind = 'scanner')))$$, pg_temp.dev('a')),
  'owner queues an update with scanner firmware');

-- ── The scanner: one applied scan, one waiting ────────────────────────────────
reset role;
set local role service_role;
insert into t_c values ('a1', pg_temp.scan('a', 1, 'use', '4791111111116')), ('a2', pg_temp.scan('a', 2, 'use', '4792222222229'));
select is((select v -> 'results' -> 0 ->> 'status' from t_c where k = 'a1'), 'used', 'A''s scanner uses A''s yoghurt');
select is((select v -> 'commands' -> 0 -> 'args' ->> 'path' from t_c where k = 'a1'),
  '00000000-0000-0000-0000-000000f11baa/scanner/0.1.0.bin', 'the update names the scanner file (the function signs a link)');
reset role;
set local role authenticated;
select is((select count(*)::int from bin_scan), 2, 'owner sees the scans');
select throws_ok($$insert into bin_scan (household_id, epoch, seq, at, mode, code, status, result) values
  ('00000000-0000-0000-0000-000000f11baa', 1, 1, now(), 'add', '4791111111116', 'added', '{}')$$, '42501', null, 'scans are written by RPCs only');
select throws_ok($$update bin_scan set status = 'dismissed'$$, '42501', null, 'scans can''t be edited');
select throws_ok($$delete from bin_scan$$, '42501', null, 'scans can''t be deleted');

-- ── Member A ──────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000f11b02","role":"authenticated"}';
select throws_ok($$select rpc_scanner_create('00000000-0000-0000-0000-000000f11baa', 'x')$$, '42501', null, 'a member can''t add a scanner');
select throws_ok(format($$select rpc_device_revoke(%L)$$, pg_temp.dev('a')), '42501', null, 'a member can''t remove it');
select throws_ok(format($$select rpc_device_command(%L, 'reboot')$$, pg_temp.dev('a')), '42501', null, 'a member can''t restart it');
select lives_ok(format($$select rpc_device_update(%L, '{"settings":{"volume":30}}')$$, pg_temp.dev('a')), 'a member may change its sound');
select lives_ok(format($$select rpc_scanner_pause(%L)$$, pg_temp.dev('a')), 'a member may pause it');
select throws_ok(format($$select rpc_scanner_resume(%L)$$, pg_temp.dev('a')), '42501', null, 'only the owner resumes it');
select throws_ok(format($$select rpc_scanner_undo_since(%L, now() - interval '1 hour')$$, pg_temp.dev('a')), '42501', null,
  'only the owner undoes everything');
select lives_ok(format($$select rpc_bin_scan_undo(%L)$$, pg_temp.row(1)), 'a member may undo a scan');
select is(pg_temp.lft(), 6::numeric, '… the yoghurt is back');

-- ── Viewer A ──────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000f11b03","role":"authenticated"}';
select is((select count(*)::int from bin_scan), 2, 'a viewer reads the scans');
select throws_ok(format($$select rpc_bin_scan_resolve(%L, 'dismiss')$$, pg_temp.row(2)), '42501', null, 'a viewer can''t resolve one');
select throws_ok(format($$select rpc_scanner_pause(%L)$$, pg_temp.dev('a')), '42501', null, 'a viewer can''t pause');

-- ── Owner B: sees and reaches nothing of A ────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000f11c01","role":"authenticated"}';
select is((select count(*)::int from device), 0, 'B sees no scanner of A');
select is((select count(*)::int from bin_scan), 0, 'B sees no scan of A');
select throws_ok(format($$select rpc_bin_scan_undo(%L)$$, pg_temp.row(2)), '42501', null, 'B can''t undo A''s scan');
select throws_ok(format($$select rpc_bin_scan_resolve(%L, 'apply')$$, pg_temp.row(2)), '42501', null, 'B can''t resolve A''s scan');
select throws_ok(format($$select rpc_scanner_pause(%L)$$, pg_temp.dev('a')), '42501', null, 'B can''t pause A''s scanner');
select throws_ok(format($$select rpc_scanner_resume(%L)$$, pg_temp.dev('a')), '42501', null, 'B can''t resume A''s scanner');
select throws_ok(format($$select rpc_device_update(%L, '{"name":"mine"}')$$, pg_temp.dev('a')), '42501', null, 'B can''t rename A''s scanner');
select throws_ok(format($$select rpc_bin_add_settle(%L)$$, gen_random_uuid()), '42501', null, 'settling needs a bill of one''s own');
insert into t_c values ('b', rpc_scanner_create('00000000-0000-0000-0000-000000f11cbb', 'Scanner B'));

-- B's scanner reads A's barcode: unknown in B, and A's stock is untouched.
reset role;
set local role service_role;
insert into t_c values ('b1', pg_temp.scan('b', 1, 'use', '4791111111116'));
select is((select v -> 'results' -> 0 ->> 'status' from t_c where k = 'b1'), 'unknown', 'A''s barcode means nothing to B''s scanner');
select is(pg_temp.lft(), 6::numeric, '… A''s stock is untouched');
select is((select v -> 'device' ->> 'household_id' from t_c where k = 'b1'), '00000000-0000-0000-0000-000000f11cbb',
  'the household comes from the key');

-- ── anon ──────────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select throws_ok($$select count(*) from bin_scan$$, '42501', null, 'anon can''t read scans');

select * from finish();
rollback;
