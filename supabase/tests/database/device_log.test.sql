-- Phase 6b · 68: the scale's log. Lines arrive only through rpc_scale_log with the scale's key (service
-- role), land in the scale's own household, are readable by its members only, never written by
-- users; a removed scale is refused; at most 30 lines per call; lines older than 7 days are pruned.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f6e01', 'p6blog-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f6f01', 'p6blog-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f6eaa', 'Log A'),
  ('00000000-0000-0000-0000-0000000f6fbb', 'Log B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f6eaa', '00000000-0000-0000-0000-0000000f6e01', 'owner'),
  ('00000000-0000-0000-0000-0000000f6fbb', '00000000-0000-0000-0000-0000000f6f01', 'owner');

create function pg_temp.h(p_k text) returns text language sql stable as
  $$ select encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = p_k), 'UTF8'), 'sha256'), 'hex') $$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6e01","role":"authenticated"}';
insert into t_c values ('a', rpc_device_create('00000000-0000-0000-0000-0000000f6eaa', 'Scale A'));
select throws_ok($$select rpc_scale_log(repeat('0', 64), 1, 1000, '[]')$$, '42501', null, 'users can''t write a scale log');
select throws_ok($$insert into device_log (household_id, device_id, line)
  values ('00000000-0000-0000-0000-0000000f6eaa', (select id from device), 'x')$$, '42501', null, 'no direct inserts');

reset role;
set local role service_role;
select is(rpc_scale_log(pg_temp.h('a'), 7, 60000,
  '[{"t":59000,"m":"[SCALE] steady: 1000.2 g (after 0.9 s)"},{"t":59500,"m":"  "},{"t":99999999,"m":"[NET] gedara: OK"}]'),
  2, 'two lines stored (the blank one is skipped)');
select throws_ok($$select rpc_scale_log(repeat('0', 64), 1, 1, '[]')$$, '42501', null, 'an unknown key is refused');
select throws_ok(format($$select rpc_scale_log(%L, 1, 1, (select jsonb_agg(jsonb_build_object('t', 1, 'm', 'x')) from generate_series(1, 31)))$$,
  pg_temp.h('a')), '23514', null, 'at most 30 lines per call');

reset role;
select is((select count(*)::int from device_log where household_id = '00000000-0000-0000-0000-0000000f6eaa'), 2, 'lines are in A');
select ok((select at between now() - interval '2 seconds' and now() - interval '0.5 seconds' from device_log
            where line like '[SCALE]%'), 'the time comes from the scale''s uptime (1 s ago)');
select is((select at from device_log where line like '[NET]%'), now(), 'an uptime from the future means "now"');
insert into device_log (household_id, device_id, at, line)
  values ('00000000-0000-0000-0000-0000000f6eaa', (select id from device where name = 'Scale A'), now() - interval '8 days', 'old');
set local role service_role;
select lives_ok(format($$select rpc_scale_log(%L, 7, 1000, '[{"t":1000,"m":"next"}]')$$, pg_temp.h('a')), 'another line');
reset role;
select is((select count(*)::int from device_log where line = 'old'), 0, 'lines older than 7 days are pruned');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6f01","role":"authenticated"}';
select is((select count(*)::int from device_log), 0, 'B can''t read A''s scale log');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6e01","role":"authenticated"}';
select is((select count(*)::int from device_log), 3, 'A reads its own scale log');

select * from finish();
rollback;
