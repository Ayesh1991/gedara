-- Phase 7i: the speaker as a network speaker. Settings take airplay / bluetooth (booleans only);
-- bt_pair opens a 2-minute window unless Bluetooth is off; bt_forget needs a real address; the
-- speaker reports its source (AirPlay + the phone's name) and its paired Bluetooth devices, whose
-- list replaces the stored one; another household can't see them and nobody writes them directly.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.h(p_token text) returns text language sql immutable as
  $$ select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7e01', 'p7i-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7f01', 'p7i-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f7eee', 'Sources A'),
  ('00000000-0000-0000-0000-0000000f7fff', 'Sources B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f7eee', '00000000-0000-0000-0000-0000000f7e01', 'owner'),
  ('00000000-0000-0000-0000-0000000f7fff', '00000000-0000-0000-0000-0000000f7f01', 'owner');

set local role service_role;
insert into t_c values ('p', rpc_media_pair_start(pg_temp.h('sources-key-a-000000000000000000000000000'), 'SRCA'));
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7e01","role":"authenticated"}';
insert into t_c values ('a', rpc_device_pair('00000000-0000-0000-0000-0000000f7eee', (select v ->> 'code' from t_c where k = 'p'), 'Speaker A'));
create function pg_temp.dev() returns uuid language sql stable as $$ select (v ->> 'id')::uuid from t_c where k = 'a' $$;

select lives_ok(format($$select rpc_device_update(%L, '{"settings":{"airplay":true,"bluetooth":true}}')$$, pg_temp.dev()), 'airplay / bluetooth settings save');
select throws_ok(format($$select rpc_device_update(%L, '{"settings":{"airplay":"yes"}}')$$, pg_temp.dev()), '23514', null, 'only true or false');
insert into t_c values ('bt', jsonb_build_object('id', rpc_media_command(pg_temp.dev(), 'bt_pair')));
select throws_ok(format($$select rpc_media_command(%L, 'bt_forget', '{"address":"nope"}')$$, pg_temp.dev()), '23514', null, 'bt_forget needs a real address');
insert into t_c values ('bf', jsonb_build_object('id', rpc_media_command(pg_temp.dev(), 'bt_forget', '{"address":"aa:bb:cc:dd:ee:01"}')));
select lives_ok(format($$select rpc_device_update(%L, '{"settings":{"bluetooth":false}}')$$, pg_temp.dev()), 'Bluetooth switched off');
select throws_ok(format($$select rpc_media_command(%L, 'bt_pair')$$, pg_temp.dev()), '23514', null, 'no pairing window while Bluetooth is off');
reset role;
select is((select args ->> 'seconds' from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'bt')), '120', 'bt_pair opens 2 minutes');
select is((select args ->> 'address' from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'bf')), 'AA:BB:CC:DD:EE:01', 'addresses are upper-cased');

set local role service_role;
select lives_ok(format($$select rpc_media_sync(%L, '{"agent":"a","up":1,
  "player":{"state":"playing","track_id":null,"elapsed_s":0,"duration_s":null,"volume":40,"sleep_until_ms":null,"shuffle":false,"repeat":"off","queue":[],"queue_index":null,"source":"airplay","source_name":"Didula''s iPhone"},
  "status":{"bluetooth":"ready","bt_devices":[{"address":"aa:bb:cc:dd:ee:01","name":"Pixel 7","connected":true},{"address":"AA:BB:CC:DD:EE:02","name":"Laptop","connected":false}]}}')$$,
  pg_temp.h('sources-key-a-000000000000000000000000000')), 'the speaker reports AirPlay and two Bluetooth devices');
reset role;
select is((select source || '|' || source_name from media_player where device_id = pg_temp.dev()), 'airplay|Didula''s iPhone', 'the source and the phone''s name are stored');
select is((select string_agg(name || ':' || connected, ',' order by address) from media_bt_device where device_id = pg_temp.dev()),
  'Pixel 7:true,Laptop:false', 'both devices, with who is connected');
set local role service_role;
select lives_ok(format($$select rpc_media_sync(%L, '{"agent":"a","up":2,"status":{"bt_devices":[{"address":"AA:BB:CC:DD:EE:02","name":"Laptop","connected":true}]}}')$$,
  pg_temp.h('sources-key-a-000000000000000000000000000')), 'a later report with one device');
reset role;
select is((select string_agg(name, ',') from media_bt_device where device_id = pg_temp.dev()), 'Laptop', 'the forgotten phone is gone from the list');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7f01","role":"authenticated"}';
select is((select count(*)::int from media_bt_device), 0, 'B can''t see A''s Bluetooth devices');
select throws_ok(format($$insert into media_bt_device (household_id, device_id, address, name)
  values ('00000000-0000-0000-0000-0000000f7fff', %L, 'AA:BB:CC:DD:EE:09', 'Sneaky')$$, pg_temp.dev()), '42501', null, 'nobody writes Bluetooth devices directly');

select * from finish();
rollback;
