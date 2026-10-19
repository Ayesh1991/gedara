-- Phase 8 RLS: another household can't read my Home Assistant entities or commands, can't command
-- or choose them, and can't pair into my household. Bridge keys are unreadable to everyone but
-- SECURITY DEFINER code; clients can't write home_entity / home_command directly. Owner and member
-- may command, a viewer only reads, only the owner chooses. The bridge RPCs are for the service
-- role only, a bridge's key only ever sees its own bridge, a speaker's key can't act as a bridge
-- (nor the other way round), and anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.h(p_token text) returns text language sql immutable as
  $$ select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f8a01', 'p8rls-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8a02', 'p8rls-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8a03', 'p8rls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8b01', 'p8rls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f8aaa', 'Home RLS A'),
  ('00000000-0000-0000-0000-0000000f8bbb', 'Home RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-0000000f8a01', 'owner'),
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-0000000f8a02', 'member'),
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-0000000f8a03', 'viewer'),
  ('00000000-0000-0000-0000-0000000f8bbb', '00000000-0000-0000-0000-0000000f8b01', 'owner');

-- Both bridges pair, and A also has a speaker.
set local role service_role;
insert into t_c values ('pa', rpc_home_pair_start(pg_temp.h('bridge-key-a-000000000000000000000000000000'), 'KEYA'));
insert into t_c values ('pb', rpc_home_pair_start(pg_temp.h('bridge-key-b-000000000000000000000000000000'), 'KEYB'));
insert into t_c values ('ps', rpc_media_pair_start(pg_temp.h('speaker-key-a-00000000000000000000000000000'), 'KEYS'));
insert into t_c values ('px', rpc_home_pair_start(pg_temp.h('bridge-key-x-000000000000000000000000000000'), 'KEYX'));
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8b01","role":"authenticated"}';
select throws_ok(format($$select rpc_device_pair('00000000-0000-0000-0000-0000000f8aaa', %L, 'Mine now', 'home')$$,
  (select v ->> 'code' from t_c where k = 'pa')), '42501', null, 'B can''t pair a bridge into A');
insert into t_c values ('b', rpc_device_pair('00000000-0000-0000-0000-0000000f8bbb', (select v ->> 'code' from t_c where k = 'pb'), 'Bridge B', 'home'));
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a02","role":"authenticated"}';
select throws_ok(format($$select rpc_device_pair('00000000-0000-0000-0000-0000000f8aaa', %L, 'Member', 'home')$$,
  (select v ->> 'code' from t_c where k = 'px')), '42501', null, 'a member can''t pair one (owner only)');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a01","role":"authenticated"}';
insert into t_c values ('a', rpc_device_pair('00000000-0000-0000-0000-0000000f8aaa', (select v ->> 'code' from t_c where k = 'pa'), 'Bridge A', 'home'));
insert into t_c values ('s', rpc_device_pair('00000000-0000-0000-0000-0000000f8aaa', (select v ->> 'code' from t_c where k = 'ps'), 'Speaker A'));
reset role;
select is((select string_agg(kind, ',' order by kind) from device where household_id = '00000000-0000-0000-0000-0000000f8aaa'), 'home,media',
  'A has a bridge and a speaker');

set local role service_role;
insert into t_c values ('sa', rpc_home_sync(pg_temp.h('bridge-key-a-000000000000000000000000000000'), $${"agent":"a","up":1,
  "catalog":[{"entity_id":"climate.ac_a","domain":"climate","kind":"climate","name":"AC A","area":"Bedroom"},
             {"entity_id":"binary_sensor.window_a","domain":"binary_sensor","kind":"window","name":"Window A"}],
  "states":[{"entity_id":"climate.ac_a","state":"cool"},{"entity_id":"binary_sensor.window_a","state":"off"}]}$$));
insert into t_c values ('sb', rpc_home_sync(pg_temp.h('bridge-key-b-000000000000000000000000000000'), $${"agent":"b","up":1,
  "catalog":[{"entity_id":"climate.ac_b","domain":"climate","kind":"climate","name":"AC B"}],
  "states":[{"entity_id":"climate.ac_b","state":"cool"}]}$$));
reset role;
create function pg_temp.ent(p_entity text) returns uuid language sql stable as $$ select id from home_entity where entity_id = p_entity $$;

-- ── Reading ───────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a03","role":"authenticated"}';
select is((select string_agg(entity_id, ',' order by entity_id) from home_entity), 'binary_sensor.window_a,climate.ac_a',
  'A''s viewer sees A''s entities only');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8b01","role":"authenticated"}';
select is((select string_agg(entity_id, ',') from home_entity), 'climate.ac_b', 'B sees only B''s');
select throws_ok($$select count(*) from home_token$$, '42501', null, 'bridge keys are unreadable');
select throws_ok($$insert into home_entity (household_id, device_id, entity_id, domain, kind, ha_name)
  values ('00000000-0000-0000-0000-0000000f8bbb', (select (v ->> 'id')::uuid from t_c where k = 'b'), 'switch.fake', 'switch', 'switch', 'Fake')$$,
  '42501', null, 'entities can''t be written directly');
select throws_ok($$update home_entity set controllable = true$$, '42501', null, '… nor changed directly');
select throws_ok($$insert into home_command (household_id, device_id, entity, entity_id, action)
  select household_id, device_id, id, entity_id, 'turn_on' from home_entity$$, '42501', null, 'commands can''t be written directly');

-- ── Choosing and commanding ───────────────────────────────────────────────────
select throws_ok(format($$select rpc_home_command(%L, 'turn_on')$$, pg_temp.ent('climate.ac_a')), '42501', null,
  'B can''t command A''s AC');
select throws_ok(format($$select rpc_home_entity_set(%L, '{"shown":false}')$$, pg_temp.ent('climate.ac_a')), '42501', null,
  'B can''t choose for A');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a03","role":"authenticated"}';
select throws_ok(format($$select rpc_home_command(%L, 'turn_off')$$, pg_temp.ent('climate.ac_a')), '42501', null,
  'A''s viewer can''t command');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a02","role":"authenticated"}';
select throws_ok(format($$select rpc_home_entity_set(%L, '{"shown":false}')$$, pg_temp.ent('climate.ac_a')), '42501', null,
  'A''s member can''t choose (owner only)');
select ok(rpc_home_command(pg_temp.ent('climate.ac_a'), 'turn_off') is not null, 'A''s member can command A''s AC');
select is((select count(*)::int from home_command), 1, 'A sees A''s command');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8b01","role":"authenticated"}';
select is((select count(*)::int from home_command), 0, 'B sees none of A''s commands');
reset role;

-- ── Keys and the service-role RPCs ────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.rpc_home_sync(text, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.rpc_home_pending(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.rpc_home_wait(text, integer)', 'execute')
          and not has_function_privilege('authenticated', 'public.rpc_home_pair_start(text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.rpc_home_pair_poll(text)', 'execute'),
  'signed-in users can''t call the bridge''s RPCs');
select ok(not has_function_privilege('anon', 'public.rpc_home_sync(text, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.rpc_home_command(uuid, text, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.rpc_home_entity_set(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.rpc_device_pair(uuid, text, text, text)', 'execute'),
  'nor can anyone signed out call any home RPC');
set local role anon;
select throws_ok($$select count(*) from home_entity$$, '42501', null, 'anon can''t read entities');
reset role;
set local role service_role;
select is(jsonb_array_length(rpc_home_pending(pg_temp.h('bridge-key-b-000000000000000000000000000000')) -> 'commands'), 0,
  'B''s bridge never gets A''s command');
select is(jsonb_array_length(rpc_home_pending(pg_temp.h('bridge-key-a-000000000000000000000000000000')) -> 'commands'), 1,
  'A''s bridge does');
select throws_ok($$select rpc_home_sync(pg_temp.h('speaker-key-a-00000000000000000000000000000'), '{"agent":"x","up":1}')$$,
  '42501', null, 'a speaker''s key can''t act as a bridge');
select throws_ok($$select rpc_media_sync(pg_temp.h('bridge-key-a-000000000000000000000000000000'), '{"agent":"x","up":1}')$$,
  '42501', null, '… nor a bridge''s key as a speaker');
insert into t_c values ('sx', rpc_home_sync(pg_temp.h('bridge-key-b-000000000000000000000000000000'),
  '{"agent":"b","up":2,"states":[{"entity_id":"climate.ac_a","state":"off"}]}'));
reset role;
select is((select state from home_entity where entity_id = 'climate.ac_a'), 'cool', 'B''s bridge can''t change A''s entity');
select is((select count(*)::int from home_entity where household_id = '00000000-0000-0000-0000-0000000f8bbb'), 1,
  '… and A''s entity ids reported by B create nothing');
select throws_ok($$select rpc_home_wait(pg_temp.h('speaker-key-a-00000000000000000000000000000'), 100)$$, '42501', null,
  'the wait needs a bridge''s key');
select ok((select relrowsecurity from pg_class where oid = 'public.home_token'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.home_entity'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.home_command'::regclass),
  'RLS is on for all three tables');

select * from finish();
rollback;
