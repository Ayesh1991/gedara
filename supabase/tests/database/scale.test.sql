-- Phase 6b behaviour: the weighing rule (vs the jar's STOCK, 2 g dead-band), consumption, no change,
-- an exact replay (same epoch + seq) moving nothing, a queued offline batch applying in order, the
-- automatic refill from other pantry stock, a partial refill waiting for a decision (Move / Count /
-- Later), stale readings superseded by a newer change in the app, below-tare, unknown tags, linking
-- by NDEF code, "Weigh empty" capturing the tare and the tag, missing tare / product, unit and
-- empty-container guards, commands and their results, config + containers cache, a bad reading
-- stored without blocking the queue, pruned sequence numbers, the app's rpc_weigh with replay and
-- undo, and a revoked scale refused.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(77);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f6d01', 'p6b-owner@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f6daa', 'Scale A');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f6daa', '00000000-0000-0000-0000-0000000f6d01', 'owner');
insert into location (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000c6d0', '00000000-0000-0000-0000-0000000f6daa', 'Pantry', 'shelf');
insert into product (id, household_id, name, stock_unit_id, default_location_id) values
  ('00000000-0000-0000-0000-00000000d6d1', '00000000-0000-0000-0000-0000000f6daa', 'Sugar', pg_temp.u('g'),
   '00000000-0000-0000-0000-00000000c6d0'),
  ('00000000-0000-0000-0000-00000000d6d2', '00000000-0000-0000-0000-0000000f6daa', 'Rice', pg_temp.u('kg'), null),
  ('00000000-0000-0000-0000-00000000d6d3', '00000000-0000-0000-0000-0000000f6daa', 'Eggs', pg_temp.u('pcs'), null),
  ('00000000-0000-0000-0000-00000000d6d4', '00000000-0000-0000-0000-0000000f6daa', 'Salt', pg_temp.u('g'), null),
  ('00000000-0000-0000-0000-00000000d6d5', '00000000-0000-0000-0000-0000000f6daa', 'Flour', pg_temp.u('g'), null);
insert into location (id, household_id, name, kind, holds_product_id, tare_g) values
  ('00000000-0000-0000-0000-00000000c6d1', '00000000-0000-0000-0000-0000000f6daa', 'Sugar jar', 'container',
   '00000000-0000-0000-0000-00000000d6d1', 400),
  ('00000000-0000-0000-0000-00000000c6d2', '00000000-0000-0000-0000-0000000f6daa', 'Rice jar', 'container',
   '00000000-0000-0000-0000-00000000d6d2', 500),
  ('00000000-0000-0000-0000-00000000c6d4', '00000000-0000-0000-0000-0000000f6daa', 'Salt jar', 'container',
   '00000000-0000-0000-0000-00000000d6d4', null),
  ('00000000-0000-0000-0000-00000000c6d5', '00000000-0000-0000-0000-0000000f6daa', 'Flour jar', 'container',
   '00000000-0000-0000-0000-00000000d6d5', null),
  ('00000000-0000-0000-0000-00000000c6d6', '00000000-0000-0000-0000-0000000f6daa', 'Spare jar', 'container', null, 300);

create function pg_temp.tok() returns text language sql stable as
  $$ select encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = 'dev'), 'UTF8'), 'sha256'), 'hex') $$;
create function pg_temp.sync(p jsonb) returns jsonb language sql volatile as
  $$ select public.rpc_scale_sync(pg_temp.tok(), '{"v":1,"fw":"0.1.0","epoch":7,"boot":3,"up":100000}'::jsonb || p) $$;
-- One weighing event: seq, gross grams, uid, `at` = now − ago (null = estimated from uptime = now).
create function pg_temp.ev(p_seq int, p_gross numeric, p_uid text default '04A1B2C3D4E5F6', p_ago interval default null,
                           p_ndef text default null) returns jsonb language sql stable as
  $$ select jsonb_strip_nulls(jsonb_build_object('seq', p_seq, 'b', 3, 't', 100000, 'type', 'weigh', 'uid', p_uid,
            'gross_g', p_gross, 'ndef', p_ndef,
            'at', case when p_ago is not null then round(extract(epoch from now() - p_ago) * 1000) end)) $$;
create function pg_temp.res(p_k text, p_i int default 0) returns jsonb language sql stable as
  $$ select v -> 'results' -> p_i from t_c where k = p_k $$;
create function pg_temp.jar(p_loc uuid) returns numeric language sql stable security definer as
  $$ select coalesce(sum(qty_remaining), 0) from public.stock_lot where location_id = p_loc $$;
create function pg_temp.consumes() returns int language sql stable security definer as
  $$ select count(*)::int from public.stock_movement where household_id = '00000000-0000-0000-0000-0000000f6daa'
       and reason = 'consume' $$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6d01","role":"authenticated"}';

-- ── Setup: 812 g in the jar, 500 g more sugar in the Pantry, a scale, a tag ───
select lives_ok($$select rpc_purchase('{"household_id":"00000000-0000-0000-0000-0000000f6daa",
  "product_id":"00000000-0000-0000-0000-00000000d6d1","qty":812,"location_id":"00000000-0000-0000-0000-00000000c6d1","total_cost":243.6}')$$,
  'sugar in the jar');
select lives_ok($$select rpc_purchase('{"household_id":"00000000-0000-0000-0000-0000000f6daa",
  "product_id":"00000000-0000-0000-0000-00000000d6d1","qty":500,"location_id":"00000000-0000-0000-0000-00000000c6d0","total_cost":150}')$$,
  'sugar in the pantry');
insert into t_c values ('dev', rpc_device_create('00000000-0000-0000-0000-0000000f6daa', 'Kitchen scale'));
select lives_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6d1', '04a1b2c3d4e5f6')$$, 'the sugar jar''s tag');
select throws_ok($$update location set holds_product_id = '00000000-0000-0000-0000-00000000d6d3'
  where id = '00000000-0000-0000-0000-00000000c6d6'$$, 'GDUNT', null, 'a jar can''t hold eggs (not weighable)');
select throws_ok($$update location set holds_product_id = '00000000-0000-0000-0000-00000000d6d4'
  where id = '00000000-0000-0000-0000-00000000c6d1'$$, 'GDCNE', null, 'a jar with sugar in it can''t switch to salt');
select isnt((select tare_set_at from location where id = '00000000-0000-0000-0000-00000000c6d1'), null, 'the tare has a date');

-- The purchases happened "yesterday" (the journal is append-only, so only the test may backdate it).
reset role;
alter table stock_movement disable trigger stock_movement_no_update;
update stock_movement set created_at = now() - interval '1 day' where household_id = '00000000-0000-0000-0000-0000000f6daa';
alter table stock_movement enable trigger stock_movement_no_update;
set local role service_role;

-- ── Weighing ──────────────────────────────────────────────────────────────────
insert into t_c values ('s1', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(1, 1212, p_ago => '90 seconds')),
  'live', jsonb_build_object('state', 'stable', 'uid', '04A1B2C3D4E5F6', 'gross_g', 1212))));
select is(pg_temp.res('s1') ->> 'status', 'no_change', '812 g in an 812 g jar: no change');
select is((pg_temp.res('s1') ->> 'left_g')::numeric, 812.0, '… 812 g left');
select is((select v -> 'acked' from t_c where k = 's1'), '[1]'::jsonb, 'reading 1 acked');
select is((select live_state || ' ' || round(live_gross_g) from device), 'stable 1212', 'the live state is on the device row');

insert into t_c values ('s2', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(2, 1188, p_ago => '80 seconds')))));
select is(pg_temp.res('s2') ->> 'status', 'consumed', 'two spoons out: consumed');
select is((pg_temp.res('s2') ->> 'delta_g')::numeric, -24.0, '… Sugar −24 g');
select is(pg_temp.res('s2') ->> 'name', 'Sugar', '… named for the device');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d1'), 788::numeric, 'the jar holds 788 g');
select is((select note from stock_movement where reason = 'consume'), 'Kitchen scale', 'the journal says where it came from');

insert into t_c values ('s2r', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(2, 1188, p_ago => '80 seconds')))));
select is((pg_temp.res('s2r') ->> 'replayed')::boolean, true, 'the same epoch + seq replays');
select is(pg_temp.res('s2r') ->> 'status', 'consumed', '… with the first answer');
select is(pg_temp.consumes(), 1, '… and nothing is taken twice');

insert into t_c values ('s3', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(3, 1189, p_ago => '70 seconds')))));
select is(pg_temp.res('s3') ->> 'status', 'no_change', '1 g heavier is noise (< 2 g)');

-- A queued offline batch: two uses in a row; the first one's movement must not supersede the second.
insert into t_c values ('s45', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(
  pg_temp.ev(5, 1168, p_ago => '30 seconds'), pg_temp.ev(4, 1178, p_ago => '60 seconds')))));
select is((select v -> 'acked' from t_c where k = 's45'), '[4, 5]'::jsonb, 'a batch is applied in seq order');
select is(pg_temp.res('s45', 1) ->> 'status', 'consumed', 'the later of two queued readings still applies');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d1'), 768::numeric, '… 788 → 778 → 768 g');

-- ── Refill: moved from the pantry by itself; more than the pantry has → ask ────
insert into t_c values ('s6', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(6, 400 + 768 + 500, p_ago => '20 seconds')))));
select is(pg_temp.res('s6') ->> 'status', 'refilled', 'the pantry pack poured in: refilled');
select is((pg_temp.res('s6') ->> 'moved_g')::numeric, 500.0, '… 500 g moved in');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d0'), 0::numeric, '… out of the pantry');
select is((select count(*)::int from stock_movement where reason = 'transfer_in'
             and location_id = '00000000-0000-0000-0000-00000000c6d1'), 1, '… as a transfer (keeps the bill price)');

insert into t_c values ('s7', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(7, 400 + 1268 + 200, p_ago => '10 seconds')))));
select is(pg_temp.res('s7') ->> 'status', 'needs_decision', '200 g heavier with nothing left elsewhere: ask');
select is((pg_temp.res('s7') ->> 'pending_g')::numeric, 200.0, '… 200 g to decide');
select is((select count(*)::int from scale_reading where status = 'needs_decision'), 1, '… one open question');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6d01","role":"authenticated"}';
select ok(exists (select 1 from attention_feed('00000000-0000-0000-0000-0000000f6daa') a where a.kind = 'scale_decision'),
  'the question is in the Attention feed');
select throws_ok($$select rpc_scale_decide((select id from scale_reading where status = 'needs_decision'), 'transfer')$$,
  'GDSTK', null, 'Move from pantry: nothing there');
select is(rpc_scale_decide((select id from scale_reading where status = 'needs_decision'), 'later') ->> 'status', 'needs_decision',
  'Later keeps the question');
insert into t_c values ('d1', rpc_scale_decide((select id from scale_reading where status = 'needs_decision'), 'adjust'));
select is((select v ->> 'status' from t_c where k = 'd1'), 'decided', 'Count correction decides it');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d1'), 1468::numeric, '… the jar holds what it weighs');
select is((select count(*)::int from stock_movement where reason = 'adjust'), 1, '… as one adjust movement');
select throws_ok($$select rpc_scale_decide((select id from scale_reading where status = 'decided'), 'adjust')$$,
  'GDDEC', null, 'a decided reading can''t be decided again');

-- ── A newer change in the app wins over an older queued reading ──────────────
select lives_ok($$select rpc_consume('{"household_id":"00000000-0000-0000-0000-0000000f6daa",
  "product_id":"00000000-0000-0000-0000-00000000d6d1","qty":100,"location_id":"00000000-0000-0000-0000-00000000c6d1"}')$$,
  'someone takes 100 g in the app');
reset role;
set local role service_role;
insert into t_c values ('s8', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(8, 900, p_ago => '8 seconds')))));
select is(pg_temp.res('s8') ->> 'status', 'superseded', 'a reading from before that change only records itself');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d1'), 1368::numeric, '… and moves nothing');

-- ── Below tare, unknown tag, NDEF link, missing tare / product ────────────────
insert into t_c values ('s9', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(9, 300)))));
select is(pg_temp.res('s9') ->> 'status', 'below_tare', 'lighter than the empty jar: lid off?');

insert into t_c values ('s10', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(10, 700, '04FFFFFFFFFFFF')))));
select is(pg_temp.res('s10') ->> 'status', 'unknown_tag', 'a tag nobody linked');

insert into t_c values ('s11', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(
  pg_temp.ev(11, 2500, '04BBBBBBBBBBBB', p_ndef => (select code from location where id = '00000000-0000-0000-0000-00000000c6d2'))))));
select is((pg_temp.res('s11') ->> 'linked')::boolean, true, 'a phone-written tag links itself by its NDEF code');
select is(pg_temp.res('s11') ->> 'status', 'needs_decision', '… 2 kg of rice and none elsewhere: ask');
select is((select location_id from nfc_tag where uid = '04BBBBBBBBBBBB'), '00000000-0000-0000-0000-00000000c6d2'::uuid,
  '… the UID now belongs to the rice jar');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6d01","role":"authenticated"}';
select lives_ok($$select rpc_scale_decide((select id from scale_reading where status = 'needs_decision'), 'adjust')$$,
  'count correction for the rice');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d2'), 2.0000::numeric, 'rice is counted in kg: 2 kg');
select ok(exists (select 1 from attention_feed('00000000-0000-0000-0000-0000000f6daa') a where a.kind = 'scale_new_tag'),
  'the unknown tag is in the Attention feed');
select lives_ok($$select rpc_container_setup('00000000-0000-0000-0000-00000000c6d4')$$, 'Weigh empty armed for the salt jar');
select lives_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6d5', '04DDDDDDDDDDDD')$$, 'flour jar tagged, no tare yet');
select lives_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6d6', '04EEEEEEEEEEEE')$$, 'spare jar tagged, no product');
select throws_ok($$select rpc_nfc_tag_link('00000000-0000-0000-0000-00000000c6d6', '04A1B2C3D4E5F6')$$, 'GDTAG', null,
  'the sugar tag can''t silently move to another jar');

reset role;
set local role service_role;
insert into t_c values ('s12', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(
  pg_temp.ev(12, 350.04, '04CCCCCCCCCCCC'), pg_temp.ev(13, 350, '04CCCCCCCCCCCC'),
  pg_temp.ev(14, 800, '04DDDDDDDDDDDD'), pg_temp.ev(15, 800, '04EEEEEEEEEEEE')))));
select is(pg_temp.res('s12') ->> 'status', 'tare_set', 'Weigh empty: the new tag''s first reading is the tare');
select is((select tare_g || ' ' || (scale_setup_until is null) from location where id = '00000000-0000-0000-0000-00000000c6d4'),
  '350.0000 true', '… 350 g, and the arming is used up');
select is(pg_temp.res('s12', 1) ->> 'status', 'no_change', '… the next reading of the empty jar is 0 g: no change');
select is(pg_temp.res('s12', 2) ->> 'status', 'no_tare', 'a jar without an empty weight asks for one');
select is(pg_temp.res('s12', 3) ->> 'status', 'no_product', 'a jar that holds nothing says so');

-- ── A bad reading is stored and acked; pruned numbers are acked, not applied ──
insert into t_c values ('s16', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(
  pg_temp.ev(16, 1000) || '{"gross_g":"lots"}'))));
select is(pg_temp.res('s16') ->> 'status', 'error', 'an unreadable weight becomes an error reading');
select is((select v -> 'acked' from t_c where k = 's16'), '[16]'::jsonb, '… acked, so the queue moves on');
reset role;
update device set seq_floor = 20;
set local role service_role;
insert into t_c values ('s17', pg_temp.sync(jsonb_build_object('events', jsonb_build_array(pg_temp.ev(18, 1000)))));
select is(pg_temp.res('s17') ->> 'status', 'pruned', 'a number below the pruned floor is acked without effect');
select throws_ok($$select pg_temp.sync(jsonb_build_object('events',
  (select jsonb_agg(pg_temp.ev(100 + i, 1000)) from generate_series(1, 21) i)))$$, '23514', null, 'at most 20 events per request');

-- ── Config, containers, commands ──────────────────────────────────────────────
select is((select (v -> 'config' ->> 'tz_offset_min')::int from t_c where k = 's1'), 330, 'quiet hours use Colombo time (+5:30)');
select is((select (v -> 'config' ->> 'threshold_g')::numeric from t_c where k = 's1'), 2::numeric, 'the 2 g dead-band is sent');
select ok((select v -> 'containers' -> 'items' @> '[{"uid":"04A1B2C3D4E5F6","name":"Sugar","tare_g":400}]'
             from t_c where k = 's1'), 'the containers list names the sugar jar');
insert into t_c values ('s18', pg_temp.sync(jsonb_build_object('containers_v',
  (select v -> 'containers' ->> 'v' from t_c where k = 's17'))));
select is((select v -> 'containers' ? 'items' from t_c where k = 's18'), false, 'an unchanged list isn''t sent again');
select is((select (v ->> 'poll_ms')::int from t_c where k = 's18'), 30000, 'idle: sync every 30 s');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6d01","role":"authenticated"}';
select throws_ok($$select rpc_device_update((select id from device), '{"settings":{"volume":150}}')$$, '23514', null,
  'volume is 0–100');
select throws_ok($$select rpc_device_command((select id from device), 'calibrate', '{"known_g":10}')$$, '23514', null,
  'a known weight below 50 g is refused');
insert into t_c values ('cmd', to_jsonb(rpc_device_command((select id from device), 'calibrate', '{"known_g":1000}')));
reset role;
set local role service_role;
insert into t_c values ('s19', pg_temp.sync('{}'));
select is((select v -> 'commands' -> 0 ->> 'command' || ' ' || (v -> 'commands' -> 0 -> 'args' ->> 'known_g') from t_c where k = 's19'),
  'calibrate 1000.0', 'the command reaches the device');
select is((select (v ->> 'poll_ms')::int from t_c where k = 's19'), 1000, '… which polls every second meanwhile');
insert into t_c values ('s20', pg_temp.sync(jsonb_build_object('done', jsonb_build_array(jsonb_build_object(
  'id', (select v #>> '{}' from t_c where k = 'cmd'), 'ok', true, 'result', '{"factor":-412.37}'::jsonb)))));
select is((select status || ' ' || (result ->> 'factor') from device_command), 'done -412.37', 'the result comes back');
select isnt((select calibrated_at from device), null, '… and the scale counts as calibrated');

-- ── The app's own weighing: replay and undo ───────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f6d01","role":"authenticated"}';
insert into t_c values ('w1', rpc_weigh('00000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-00000000c6d1', 1338));
select is((select v ->> 'status' || ' ' || (v ->> 'delta_g') from t_c where k = 'w1'), 'consumed -30.0', 'a typed weight uses 30 g');
select is((rpc_weigh('00000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-00000000c6d1', 1000) ->> 'replayed')::boolean,
  true, 'the same op id replays');
select lives_ok(format($$select rpc_undo(%L)$$, (select v ->> 'correlation_id' from t_c where k = 'w1')), 'Undo');
select is(pg_temp.jar('00000000-0000-0000-0000-00000000c6d1'), 1368::numeric, '… puts the 30 g back');

-- ── Revoked ───────────────────────────────────────────────────────────────────
select lives_ok($$select rpc_device_revoke((select id from device))$$, 'the owner removes the scale');
reset role;
set local role service_role;
select throws_ok($$select pg_temp.sync('{}')$$, '42501', null, 'a removed scale is refused');

select * from finish();
rollback;
