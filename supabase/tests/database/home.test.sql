-- Phase 8 behaviour: pairing a Home Assistant bridge by code, what it reports (defaults for new
-- entities, the owner's choices kept, the climate attributes filtered, entities gone from HA removed),
-- the owner's chooser rules, commands (controllable only, available only, temperature and mode
-- checked against the AC, replaced while waiting, picked once in order, done / failed, expiry after
-- 60 s, 60 a minute), the long-poll wait, a removed bridge, renaming, housekeeping.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(72);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.h(p_token text) returns text language sql immutable as
  $$ select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;
create function pg_temp.k() returns text language sql immutable as
  $$ select pg_temp.h('bridge-key-1-000000000000000000000000000000') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000f8c01', 'p8-owner@test.local'),
  ('00000000-0000-0000-0000-0000000f8c02', 'p8-member@test.local');
insert into household (id, name) values ('00000000-0000-0000-0000-0000000f8ccc', 'Home C');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f8ccc', '00000000-0000-0000-0000-0000000f8c01', 'owner'),
  ('00000000-0000-0000-0000-0000000f8ccc', '00000000-0000-0000-0000-0000000f8c02', 'member');

-- ── Pairing ───────────────────────────────────────────────────────────────────
set local role service_role;
insert into t_c values ('p1', rpc_home_pair_start(pg_temp.k(), 'KEYH', 'gedara-home 0.1.0'));
select ok((select v ->> 'code' from t_c where k = 'p1') ~ '^[0-9]{8}$', 'the bridge gets an 8-digit code');
select is(rpc_home_pair_start(pg_temp.k(), 'KEYH') ->> 'code', (select v ->> 'code' from t_c where k = 'p1'), 'asking again gives the same code');
select is(rpc_home_pair_poll(pg_temp.k()) ->> 'status', 'waiting', 'waiting until the owner types it');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
select is(rpc_device_pair('00000000-0000-0000-0000-0000000f8ccc', (select v ->> 'code' from t_c where k = 'p1'), 'Speaker?') ->> 'error',
  'GDPCN', 'a bridge''s code typed into "Add speaker" is a wrong code');
insert into t_c values ('b', rpc_device_pair('00000000-0000-0000-0000-0000000f8ccc', (select v ->> 'code' from t_c where k = 'p1'),
  'Home Assistant', 'home'));
select is((select v ->> 'ok' from t_c where k = 'b'), 'true', 'the right code pairs the bridge');
reset role;
create function pg_temp.dev() returns uuid language sql stable as $$ select (v ->> 'id')::uuid from t_c where k = 'b' $$;
select is((select kind || '|' || name || '|' || settings::text from device where id = pg_temp.dev()), 'home|Home Assistant|{}',
  'a bridge device with no settings');
set local role service_role;
select is(rpc_home_pair_poll(pg_temp.k()) ->> 'household', 'Home C', 'the bridge learns it is paired, and to which household');
insert into t_c values ('p2', rpc_home_pair_start(pg_temp.h('bridge-key-2-000000000000000000000000000000'), 'KEY2'));
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
select throws_ok(format($$select rpc_device_pair('00000000-0000-0000-0000-0000000f8ccc', %L, 'Second', 'home')$$,
  (select v ->> 'code' from t_c where k = 'p2')), '23514', null, 'one bridge per household');
reset role;

-- ── What the bridge reports ───────────────────────────────────────────────────
set local role service_role;
insert into t_c values ('s1', rpc_home_sync(pg_temp.k(), $${"agent":"gedara-home 0.1.0","up":5,"status":{"ha":"connected"},
  "catalog":[
    {"entity_id":"binary_sensor.bedroom_window_2","domain":"binary_sensor","kind":"window","name":"Bedroom Window 2","area":"Bedroom","device_class":"window"},
    {"entity_id":"binary_sensor.front_door","domain":"binary_sensor","kind":"door","name":"Front door","area":"Living Room","device_class":"door"},
    {"entity_id":"light.mist_rgb","domain":"light","kind":"light","name":"Mist maker Mist RGB Light","area":"Bedroom"},
    {"entity_id":"switch.mosquito_vaporizer","domain":"switch","kind":"switch","name":"Mosquito Vaporizer","area":"Bedroom"},
    {"entity_id":"climate.bedroom_ac","domain":"climate","kind":"climate","name":"AC","area":"Bedroom"},
    {"entity_id":"switch.old_plug","domain":"switch","kind":"switch","name":"Old plug"}],
  "catalog_full":true,
  "states":[
    {"entity_id":"binary_sensor.bedroom_window_2","state":"on","changed_at":"2026-10-19T08:00:00Z"},
    {"entity_id":"binary_sensor.front_door","state":"off"},
    {"entity_id":"light.mist_rgb","state":"unavailable"},
    {"entity_id":"switch.mosquito_vaporizer","state":"off"},
    {"entity_id":"climate.bedroom_ac","state":"cool","attrs":{"current_temperature":28.9,"temperature":24,"min_temp":16,"max_temp":30,
      "hvac_modes":["off","cool","dry","fan_only"],"friendly_name":"AC","target_temp_step":"0.5"}},
    {"entity_id":"light.not_listed","state":"on"}]}$$));
reset role;
create function pg_temp.e(p_entity text) returns uuid language sql stable as
  $$ select id from home_entity where device_id = pg_temp.dev() and entity_id = p_entity $$;
select is((select string_agg(entity_id || ':' || shown || ':' || controllable, ',' order by entity_id) from home_entity where device_id = pg_temp.dev()),
  'binary_sensor.bedroom_window_2:true:false,binary_sensor.front_door:true:false,climate.bedroom_ac:true:true,light.mist_rgb:true:false,switch.mosquito_vaporizer:false:false,switch.old_plug:false:false',
  'defaults: doors, windows, lights and the AC shown, the AC controllable, switches hidden');
select is((select state || '|' || area || '|' || (changed_at = '2026-10-19T08:00:00Z'::timestamptz) from home_entity where id = pg_temp.e('binary_sensor.bedroom_window_2')),
  'on|Bedroom|true', 'the window is open, in the Bedroom, since HA said so');
select is((select attrs from home_entity where id = pg_temp.e('climate.bedroom_ac')),
  '{"current_temperature":28.9,"temperature":24,"min_temp":16,"max_temp":30,"hvac_modes":["off","cool","dry","fan_only"]}'::jsonb,
  'only the AC attributes Gedara shows are kept, with their types checked');
select is((select count(*)::int from home_entity where entity_id = 'light.not_listed'), 0, 'a state for something never listed is ignored');
select is((select v ->> 'need_catalog' from t_c where k = 's1'), 'false', 'it has a catalog now');
select is((select fw_version || '|' || (status ->> 'ha') from device where id = pg_temp.dev()), 'gedara-home 0.1.0|connected',
  'the bridge''s version and Home Assistant''s state are kept');
set local role service_role;
select throws_ok($$select rpc_home_sync(pg_temp.k(), '{"agent":"a","up":1,"catalog":[{"entity_id":"lock.front","domain":"lock","kind":"switch","name":"Front lock"}]}')$$,
  '23514', null, 'a lock is not something the bridge may report');
select throws_ok($$select rpc_home_sync(pg_temp.h('nobody-0000000000000000000000000000000000'), '{"agent":"a","up":1}')$$,
  '42501', null, 'a key that isn''t a bridge is refused');
reset role;

-- ── The owner's chooser ───────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
select throws_ok(format($$select rpc_home_entity_set(%L, '{"controllable":true}')$$, pg_temp.e('binary_sensor.front_door')),
  '23514', null, 'doors and windows can only be shown');
select is(rpc_home_entity_set(pg_temp.e('switch.mosquito_vaporizer'), '{"controllable":true,"label":"  Vaporizer "}'),
  jsonb_build_object('id', pg_temp.e('switch.mosquito_vaporizer'), 'shown', true, 'controllable', true, 'label', 'Vaporizer', 'logged', false, 'alert', false),
  'making a switch controllable also shows it; the short name is trimmed');
select is(rpc_home_entity_set(pg_temp.e('climate.bedroom_ac'), '{"shown":false}') ->> 'controllable', 'false', 'hiding something stops its control');
select is(rpc_home_entity_set(pg_temp.e('climate.bedroom_ac'), '{"controllable":true}') ->> 'shown', 'true', '… and controlling it shows it again');
select throws_ok(format($$select rpc_home_entity_set(%L, '{"label":"%s"}')$$, pg_temp.e('light.mist_rgb'), repeat('x', 41)),
  '23514', null, 'a short name is at most 40 characters');
select throws_ok(format($$select rpc_home_entity_set(%L, '{"colour":"red"}')$$, pg_temp.e('light.mist_rgb')), '23514', null,
  'only shown, controllable and label can change');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
select throws_ok(format($$select rpc_home_entity_set(%L, '{"shown":false}')$$, pg_temp.e('light.mist_rgb')), '42501', null,
  'only the owner chooses');
reset role;
set local role service_role;
insert into t_c values ('s2', rpc_home_sync(pg_temp.k(), $${"agent":"a","up":9,"catalog_full":true,"catalog":[
    {"entity_id":"binary_sensor.bedroom_window_2","domain":"binary_sensor","kind":"window","name":"Bedroom Window 2","area":"Bedroom"},
    {"entity_id":"binary_sensor.front_door","domain":"binary_sensor","kind":"door","name":"Front door","area":"Living Room"},
    {"entity_id":"light.mist_rgb","domain":"light","kind":"light","name":"Mist RGB","area":"Bedroom"},
    {"entity_id":"switch.mosquito_vaporizer","domain":"switch","kind":"switch","name":"Mosquito Vaporizer","area":"Bedroom"},
    {"entity_id":"climate.bedroom_ac","domain":"climate","kind":"climate","name":"AC","area":"Bedroom"}]}$$));
reset role;
select is((select label || '|' || controllable from home_entity where id = pg_temp.e('switch.mosquito_vaporizer')), 'Vaporizer|true',
  'a new catalog keeps the owner''s choices');
select is((select ha_name from home_entity where id = pg_temp.e('light.mist_rgb')), 'Mist RGB', '… and takes HA''s new name');
select is((select count(*)::int from home_entity where entity_id = 'switch.old_plug'), 0, 'something gone from HA is gone from Gedara');

-- ── Commands ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
select throws_ok(format($$select rpc_home_command(%L, 'turn_on')$$, pg_temp.e('light.mist_rgb')), '42501', null,
  'a light the owner didn''t make controllable can''t be switched');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
insert into t_c values ('lc', rpc_home_entity_set(pg_temp.e('light.mist_rgb'), '{"controllable":true}'));
select throws_ok(format($$select rpc_home_command(%L, 'turn_on')$$, pg_temp.e('light.mist_rgb')), '23514', null,
  'something HA says is unavailable can''t be switched');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
select throws_ok(format($$select rpc_home_command(%L, 'set_temperature', '{"temperature":31}')$$, pg_temp.e('climate.bedroom_ac')),
  '23514', null, 'a temperature above the AC''s maximum is refused');
select throws_ok(format($$select rpc_home_command(%L, 'set_temperature', '{"temperature":24.3}')$$, pg_temp.e('climate.bedroom_ac')),
  '23514', null, '… and one that isn''t in half degrees');
select throws_ok(format($$select rpc_home_command(%L, 'set_hvac_mode', '{"hvac_mode":"heat"}')$$, pg_temp.e('climate.bedroom_ac')),
  '23514', null, 'a mode this AC doesn''t have is refused');
select throws_ok(format($$select rpc_home_command(%L, 'set_temperature', '{"temperature":24}')$$, pg_temp.e('switch.mosquito_vaporizer')),
  '23514', null, 'a switch has no temperature');
select throws_ok(format($$select rpc_home_command(%L, 'unlock')$$, pg_temp.e('switch.mosquito_vaporizer')), '23514', null,
  'an unknown command is refused');
insert into t_c values ('c1', to_jsonb(rpc_home_command(pg_temp.e('switch.mosquito_vaporizer'), 'turn_on')));
insert into t_c values ('c2', to_jsonb(rpc_home_command(pg_temp.e('switch.mosquito_vaporizer'), 'turn_off')));
insert into t_c values ('c3', to_jsonb(rpc_home_command(pg_temp.e('climate.bedroom_ac'), 'set_temperature', '{"temperature":24.5}')));
insert into t_c values ('c4', to_jsonb(rpc_home_command(pg_temp.e('climate.bedroom_ac'), 'set_hvac_mode', '{"hvac_mode":"dry","extra":1}')));
reset role;
select is((select status from home_command where id = (select (v #>> '{}')::uuid from t_c where k = 'c1')), 'expired',
  'off before the bridge picked on: the on is replaced');
select is((select args from home_command where id = (select (v #>> '{}')::uuid from t_c where k = 'c4')), '{"hvac_mode":"dry"}'::jsonb,
  'only the checked arguments are kept');
select is((select created_by from home_command where id = (select (v #>> '{}')::uuid from t_c where k = 'c3')),
  '00000000-0000-0000-0000-0000000f8c02'::uuid, 'each command records who sent it (Sandeepani can control)');
set local role service_role;
insert into t_c values ('pend', rpc_home_pending(pg_temp.k()));
reset role;
select is((select jsonb_agg(c ->> 'entity_id' || ':' || (c ->> 'action')) from jsonb_array_elements((select v -> 'commands' from t_c where k = 'pend')) c),
  '["switch.mosquito_vaporizer:turn_off","climate.bedroom_ac:set_temperature","climate.bedroom_ac:set_hvac_mode"]'::jsonb,
  'the bridge gets the commands in order, with HA''s entity ids');
set local role service_role;
select is(jsonb_array_length(rpc_home_pending(pg_temp.k()) -> 'commands'), 0, '… once');
insert into t_c values ('s3', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 12, 'done', jsonb_build_array(
  jsonb_build_object('id', (select v #>> '{}' from t_c where k = 'c2'), 'ok', true),
  jsonb_build_object('id', (select v #>> '{}' from t_c where k = 'c3'), 'ok', false, 'error', 'HA: entity not available')))));
reset role;
select is((select string_agg(status || coalesce(':' || error, ''), ',' order by created_at) from home_command
            where id in (select (v #>> '{}')::uuid from t_c where k in ('c2', 'c3'))),
  'done,failed:HA: entity not available', 'done and failed (with HA''s reason) come back');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
insert into t_c values ('c5', to_jsonb(rpc_home_command(pg_temp.e('switch.mosquito_vaporizer'), 'turn_on')));
reset role;
update home_command set created_at = now() - interval '2 minutes' where id = (select (v #>> '{}')::uuid from t_c where k = 'c5');
set local role service_role;
select is(jsonb_array_length(rpc_home_pending(pg_temp.k()) -> 'commands'), 0, 'a command nobody picked up within 60 s …');
reset role;
select is((select status from home_command where id = (select (v #>> '{}')::uuid from t_c where k = 'c5')), 'expired', '… expires');

-- ── The long-poll wait ────────────────────────────────────────────────────────
set local role service_role;
insert into t_c values ('w0', to_jsonb(extract(epoch from clock_timestamp())));
insert into t_c values ('w1', to_jsonb(rpc_home_wait(pg_temp.k(), 300)));
insert into t_c values ('w2', to_jsonb(extract(epoch from clock_timestamp())));
reset role;
select ok((select v from t_c where k = 'w1') = 'false'::jsonb
          and (select (b.v)::numeric - (a.v)::numeric from t_c a, t_c b where a.k = 'w0' and b.k = 'w2') >= 0.25,
  'nothing to do: the wait says no after the time it was given');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
insert into t_c values ('c6', to_jsonb(rpc_home_command(pg_temp.e('switch.mosquito_vaporizer'), 'turn_on')));
reset role;
set local role service_role;
insert into t_c values ('w3', to_jsonb(extract(epoch from clock_timestamp())));
insert into t_c values ('w4', to_jsonb(rpc_home_wait(pg_temp.k(), 7000)));
insert into t_c values ('w5', to_jsonb(extract(epoch from clock_timestamp())));
reset role;
select ok((select v from t_c where k = 'w4') = 'true'::jsonb
          and (select (b.v)::numeric - (a.v)::numeric from t_c a, t_c b where a.k = 'w3' and b.k = 'w5') < 0.25,
  'a queued command ends the wait at once');

-- ── Phase 8b: sensors, the log, each person's alerts ─────────────────────────
set local role service_role;
insert into t_c values ('s8', rpc_home_sync(pg_temp.k(), $${"agent":"gedara-home 0.2.0","up":30,"catalog":[
    {"entity_id":"binary_sensor.bedroom_presence","domain":"binary_sensor","kind":"presence","name":"Bedroom Presence","area":"Bedroom","platform":"esphome"},
    {"entity_id":"binary_sensor.living_room_dark","domain":"binary_sensor","kind":"binary","name":"Dark Detection","area":"Living Room","platform":"esphome","device_class":"light"},
    {"entity_id":"sensor.bedroom_temperature","domain":"sensor","kind":"sensor","name":"Bedroom Temperature","area":"Bedroom","platform":"esphome","unit":"°C"}]}$$));
reset role;
select is((select string_agg(kind || ':' || shown || ':' || logged || ':' || alert || ':' || coalesce(unit, '-'), ',' order by entity_id)
             from home_entity where device_id = pg_temp.dev() and kind in ('presence', 'binary', 'sensor')),
  'presence:true:true:false:-,binary:true:true:false:-,sensor:true:true:false:°C',
  'presence, other binary sensors and sensor values are shown and logged; they don''t alert by themselves');
select is((select logged::text || alert::text from home_entity where id = pg_temp.e('binary_sensor.bedroom_window_2')), 'truetrue',
  'windows are logged and alert');
select is((select logged::text from home_entity where id = pg_temp.e('light.mist_rgb')), 'false', 'lights aren''t logged unless chosen');
set local role service_role;
select throws_ok($$select rpc_home_sync(pg_temp.k(), '{"agent":"a","up":1,"catalog":[{"entity_id":"sensor.x","domain":"sensor","kind":"presence","name":"X"}]}')$$,
  '23514', null, 'a sensor can''t pretend to be a presence sensor');
reset role;

-- The owner turns door & window alerts on (this browser has notifications on); the member leaves them off.
insert into push_subscription (household_id, user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000f8ccc', '00000000-0000-0000-0000-0000000f8c01', 'https://push.example/owner-phone', repeat('A', 87), repeat('B', 22)),
  ('00000000-0000-0000-0000-0000000f8ccc', '00000000-0000-0000-0000-0000000f8c02', 'https://push.example/member-phone', repeat('C', 87), repeat('D', 22));
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
select is(rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', '{"doors":"always"}') ->> 'doors', 'always', 'the owner turns door alerts on');
select throws_ok($$select rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', '{"doors":"sometimes"}')$$, '23514', null,
  'only off, always or at night');
select throws_ok($$select rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', '{"night_from":"25:00"}')$$, '23514', null,
  'a night needs real times');
select throws_ok(format($$select rpc_home_entity_set(%L, '{"alert":true}')$$, pg_temp.e('light.mist_rgb')), '23514', null,
  'a light can''t alert');
reset role;

set local role service_role;
insert into t_c values ('ev1', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 40, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_window_2', 'state', 'on', 'at', now() - interval '60 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_presence', 'state', 'on', 'at', now() - interval '50 seconds'),
  jsonb_build_object('entity_id', 'sensor.bedroom_temperature', 'state', '28.9', 'at', now() - interval '40 seconds'),
  jsonb_build_object('entity_id', 'light.mist_rgb', 'state', 'on', 'at', now() - interval '40 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_window_2', 'state', 'off', 'at', now() - interval '3 days')))));
reset role;
select is((select string_agg(kind || '=' || state || coalesce(':' || value::text || unit, ''), ',' order by at) from home_event where device_id = pg_temp.dev()),
  'window=on,presence=on,sensor=28.9:28.9000°C', 'the log keeps the window, the person and the temperature with HA''s times (not the light, not 3 days ago)');
select is((select jsonb_agg(a ->> 'endpoint' || '|' || (a ->> 'title')) from jsonb_array_elements((select v -> 'alerts' from t_c where k = 'ev1')) a),
  '["https://push.example/owner-phone|🪟 Bedroom Window 2 opened"]'::jsonb, 'the window alerts the owner''s phone only (the member left alerts off)');
select is((select count(*)::int from home_alert_sent where user_id = '00000000-0000-0000-0000-0000000f8c02'), 0, 'nothing is sent to the member');
set local role service_role;
insert into t_c values ('ev2', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 41, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_window_2', 'state', 'on', 'at', now() - interval '60 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_window_2', 'state', 'off', 'at', now() - interval '30 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_window_2', 'state', 'on', 'at', now() - interval '10 seconds')))));
reset role;
select is((select count(*)::int from home_event where entity = pg_temp.e('binary_sensor.bedroom_window_2')), 3, 'sent again: kept once; closed and opened again: both logged');
select is(jsonb_array_length((select v -> 'alerts' from t_c where k = 'ev2')), 0, 'opened again within 2 minutes: no second alert');

-- At night only: a night that isn't now, then one that is.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
insert into t_c values ('n1', rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', jsonb_build_object('doors', 'night',
  'night_from', to_char(now() at time zone 'Asia/Colombo' + interval '2 hours', 'HH24:MI'),
  'night_to', to_char(now() at time zone 'Asia/Colombo' + interval '3 hours', 'HH24:MI'))));
reset role;
set local role service_role;
insert into t_c values ('ev3', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 42, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.front_door', 'state', 'on', 'at', now() - interval '30 seconds')))));
reset role;
select is(jsonb_array_length((select v -> 'alerts' from t_c where k = 'ev3')), 0, '"at night" doesn''t alert in the day');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
insert into t_c values ('n2', rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', jsonb_build_object(
  'night_from', to_char(now() at time zone 'Asia/Colombo' - interval '1 hour', 'HH24:MI'),
  'night_to', to_char(now() at time zone 'Asia/Colombo' + interval '1 hour', 'HH24:MI'))));
reset role;
set local role service_role;
insert into t_c values ('ev4', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 43, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.front_door', 'state', 'on', 'at', now() - interval '20 seconds')))));
reset role;
select is((select a ->> 'title' from jsonb_array_elements((select v -> 'alerts' from t_c where k = 'ev4')) a), '🚪 Front door opened',
  '… and does at night (a night may run past midnight)');

-- People detected: the owner lets the bedroom sensor alert and chooses "always".
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
insert into t_c values ('pa', rpc_home_entity_set(pg_temp.e('binary_sensor.bedroom_presence'), '{"alert":true}'));
insert into t_c values ('pp', rpc_home_alert_pref_set('00000000-0000-0000-0000-0000000f8ccc', '{"presence":"always"}'));
reset role;
set local role service_role;
insert into t_c values ('ev5', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 44, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_presence', 'state', 'off', 'at', now() - interval '15 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_presence', 'state', 'on', 'at', now() - interval '10 seconds')))));
insert into t_c values ('ev6', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 45, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_presence', 'state', 'off', 'at', now() - interval '5 seconds'),
  jsonb_build_object('entity_id', 'binary_sensor.bedroom_presence', 'state', 'on', 'at', now() - interval '2 seconds')))));
reset role;
select is((select a ->> 'title' from jsonb_array_elements((select v -> 'alerts' from t_c where k = 'ev5')) a), '🚶 Someone in Bedroom',
  'someone detected alerts the owner');
select is(jsonb_array_length((select v -> 'alerts' from t_c where k = 'ev6')), 0, '… at most every 10 minutes');
set local role service_role;
insert into t_c values ('ev7', rpc_home_sync(pg_temp.k(), jsonb_build_object('agent', 'a', 'up', 46, 'events', jsonb_build_array(
  jsonb_build_object('entity_id', 'binary_sensor.front_door', 'state', 'off', 'at', now() - interval '25 minutes'),
  jsonb_build_object('entity_id', 'binary_sensor.front_door', 'state', 'on', 'at', now() - interval '20 minutes')))));
reset role;
select ok(jsonb_array_length((select v -> 'alerts' from t_c where k = 'ev7')) = 0
          and (select count(*) from home_event where entity = pg_temp.e('binary_sensor.front_door') and at < now() - interval '19 minutes') = 2,
  'an opening reported late (internet was down) is logged but doesn''t alert');

-- Retention: 90 days of sensor values, a year of the rest.
insert into home_event (household_id, device_id, entity, entity_id, name, kind, state, value, at)
  select '00000000-0000-0000-0000-0000000f8ccc', pg_temp.dev(), pg_temp.e('sensor.bedroom_temperature'), 'sensor.bedroom_temperature', 'T', 'sensor', '27', 27, now() - interval '100 days';
insert into home_event (household_id, device_id, entity, entity_id, name, kind, state, at)
  select '00000000-0000-0000-0000-0000000f8ccc', pg_temp.dev(), pg_temp.e('binary_sensor.front_door'), 'binary_sensor.front_door', 'D', 'door', 'on', now() - interval '100 days';
do $$ begin perform private.housekeeping(); end $$;
select is((select string_agg(kind, ',' order by kind) from home_event where at < now() - interval '99 days'), 'door',
  'housekeeping drops sensor values after 90 days, keeps doors for a year');

-- ── Limits, renaming, removal, housekeeping ───────────────────────────────────
insert into home_command (household_id, device_id, entity, entity_id, action, status)
  select '00000000-0000-0000-0000-0000000f8ccc', pg_temp.dev(), pg_temp.e('switch.mosquito_vaporizer'), 'switch.mosquito_vaporizer', 'turn_on', 'done'
  from generate_series(1, 60);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c02","role":"authenticated"}';
select throws_ok(format($$select rpc_home_command(%L, 'turn_off')$$, pg_temp.e('switch.mosquito_vaporizer')), 'GDRTE', null,
  'at most 60 commands a minute');
select throws_ok(format($$select rpc_device_update(%L, '{"settings":{"volume":5}}')$$, pg_temp.dev()), '23514', null,
  'a bridge has no settings');
select is(rpc_device_update(pg_temp.dev(), '{"name":"House"}') ->> 'settings', '{}', 'it can be renamed');
reset role;
update home_command set created_at = now() - interval '31 days' where entity_id = 'switch.mosquito_vaporizer' and status = 'done';
do $$ begin perform private.housekeeping(); end $$;
select is((select count(*)::int from home_command where device_id = pg_temp.dev() and created_at < now() - interval '30 days'), 0,
  'housekeeping keeps 30 days of commands');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8c01","role":"authenticated"}';
select lives_ok(format($$select rpc_device_revoke(%L)$$, pg_temp.dev()), 'the owner removes the bridge');
select throws_ok(format($$select rpc_home_command(%L, 'turn_on')$$, (select v ->> 'id' from t_c where k = 'pa')), '42501', null,
  'a removed bridge takes no commands (what it reported is gone)');
reset role;
set local role service_role;
select throws_ok($$select rpc_home_sync(pg_temp.k(), '{"agent":"a","up":1}')$$, '42501', null, '… and its key no longer works');
reset role;
select is((select count(*)::int from home_token where device_id = pg_temp.dev()), 0, 'the key is forgotten');
select is((select count(*)::int from home_entity where device_id = pg_temp.dev()), 0, 'what it reported goes with it (no old doors after connecting again)');
select ok((select count(*) from home_event where device_id = pg_temp.dev()) > 0, '… the house log keeps its history');

select * from finish();
rollback;
