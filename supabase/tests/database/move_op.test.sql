-- Phase 7b behaviour: rpc_move puts a thing or a place into a place. A replayed op id moves once;
-- a queued (offline) move whose item was moved again after the tap is refused (GDMVC 'newer') unless
-- forced; two queued moves of the same item replay in order; Undo only moves back if the item is
-- still where the move put it; a place can't go inside itself; paths follow; the thing's timeline
-- records the move.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7501', 'p7bmv-owner@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f75aa', 'Moves A');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f75aa', '00000000-0000-0000-0000-0000000f7501', 'owner');
insert into location (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000c751', '00000000-0000-0000-0000-0000000f75aa', 'Store room', 'room'),
  ('00000000-0000-0000-0000-00000000c752', '00000000-0000-0000-0000-0000000f75aa', 'Shelf 2', 'shelf'),
  ('00000000-0000-0000-0000-00000000c753', '00000000-0000-0000-0000-0000000f75aa', 'Box 3', 'container');
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000a751', '00000000-0000-0000-0000-0000000f75aa', 'Drill');

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.at() returns uuid language sql stable as
  $$ select location_id from public.asset where id = '00000000-0000-0000-0000-00000000a751' $$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7501","role":"authenticated"}';

-- ── Online move + replay ──────────────────────────────────────────────────────
insert into t_c values ('m1', rpc_move('00000000-0000-0000-0000-0000000004a1', 'asset',
  '00000000-0000-0000-0000-00000000a751', '00000000-0000-0000-0000-00000000c753'));
select is(pg_temp.at(), '00000000-0000-0000-0000-00000000c753'::uuid, 'the drill is in Box 3');
select is((select v ->> 'from' from t_c where k = 'm1'), null::text, 'it came from nowhere (for Undo)');
select is((select count(*)::int from move_op), 1, 'one op remembered');
select is((select moved_at is not null from asset where id = '00000000-0000-0000-0000-00000000a751'), true, 'moved_at stamped');
insert into t_c values ('m1b', rpc_move('00000000-0000-0000-0000-0000000004a1', 'asset',
  '00000000-0000-0000-0000-00000000a751', '00000000-0000-0000-0000-00000000c752'));
select is((select (v ->> 'replayed')::boolean from t_c where k = 'm1b'), true, 'the same op id replays');
select is(pg_temp.at(), '00000000-0000-0000-0000-00000000c753'::uuid, '… and moves nothing');
select ok(exists (select 1 from activity where entity_id = '00000000-0000-0000-0000-00000000a751' and verb = 'moved'),
  'the thing''s timeline shows the move');

-- ── Undo expects the item where the move put it ───────────────────────────────
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751', null, null, false,
  '{"from":"00000000-0000-0000-0000-00000000c752"}')$$, 'GDMVC', null, 'Undo refuses when the thing isn''t where it expects');
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751', null, null, false,
  '{"from":"00000000-0000-0000-0000-00000000c753"}')$$, 'Undo moves it back');
select is(pg_temp.at(), null::uuid, 'back to no place');

-- ── Offline: newest wins, nothing silent ──────────────────────────────────────
-- An online move now; an offline tap from an hour ago arrives later → parked.
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751', '00000000-0000-0000-0000-00000000c751')$$,
  'moved to the Store room online');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751',
  '00000000-0000-0000-0000-00000000c753', now() - interval '1 hour')$$, 'GDMVC', null, 'an older offline move is refused');
select is(pg_temp.at(), '00000000-0000-0000-0000-00000000c751'::uuid, '… the newer place stays');
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751',
  '00000000-0000-0000-0000-00000000c753', now() - interval '1 hour', true)$$, '"Move anyway" forces it');
select is(pg_temp.at(), '00000000-0000-0000-0000-00000000c753'::uuid, 'now in Box 3');
-- Two queued moves of the same item (tapped t-10 min, then t-5 min) replay in order.
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751',
  '00000000-0000-0000-0000-00000000c751', now() + interval '1 hour')$$, 'a tap time in the future counts as now');
update asset set location_id = null where id = '00000000-0000-0000-0000-00000000a751';
select lives_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a751', '00000000-0000-0000-0000-00000000c752',
  clock_timestamp() + interval '1 second')$$, 'a queued move tapped after the last move applies');
select is((select moved_at <= now() from asset where id = '00000000-0000-0000-0000-00000000a751'), true, 'moved_at is never in the future');

-- ── Places into places ────────────────────────────────────────────────────────
select lives_ok($$select rpc_move(gen_random_uuid(), 'location', '00000000-0000-0000-0000-00000000c753', '00000000-0000-0000-0000-00000000c752')$$,
  'Box 3 goes onto Shelf 2');
select is((select path from location where id = '00000000-0000-0000-0000-00000000c753'), 'Shelf 2 › Box 3', 'its path follows');
select throws_ok($$select rpc_move(gen_random_uuid(), 'location', '00000000-0000-0000-0000-00000000c752', '00000000-0000-0000-0000-00000000c753')$$,
  '23514', null, 'Shelf 2 can''t go inside its own box');
select throws_ok($$select rpc_move(gen_random_uuid(), 'shelf', '00000000-0000-0000-0000-00000000c752', null)$$,
  '23514', null, 'unknown kind refused');

select * from finish();
rollback;
