-- Phase 7h behaviour: pairing by code (same code twice, wrong codes counted and limited, expiry, at
-- most 2 speakers), uploads (inbox path, duplicate by sha256, 60 MB and 300 MB limits, "done" needs
-- the whole object), the speaker's sync (downloads handed out once, downloaded → ready + inbox
-- trash, player state, folder songs, plays), commands (queue resolved to songs on the card, index
-- kept on the right song, volume capped and coalesced, unknown refused, expiry after 60 s), deleting,
-- playlists, schedules with their version, speaker settings, housekeeping.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(57);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.h(p_token text) returns text language sql immutable as
  $$ select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;
create function pg_temp.k(p_n integer) returns text language sql immutable as
  $$ select pg_temp.h('speaker-key-' || p_n || '-0000000000000000000000000000000') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000f7c01', 'p7h-owner@test.local');
insert into household (id, name) values ('00000000-0000-0000-0000-0000000f7ccc', 'Music C'),
  ('00000000-0000-0000-0000-0000000f7ddd', 'Music D');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f7ccc', '00000000-0000-0000-0000-0000000f7c01', 'owner');

-- ── Pairing ───────────────────────────────────────────────────────────────────
set local role service_role;
insert into t_c values ('p1', rpc_media_pair_start(pg_temp.k(1), 'KEY1', 'gedara-media 0.1.0'));
select ok((select v ->> 'code' from t_c where k = 'p1') ~ '^[0-9]{6}$', 'the Pi gets a 6-digit code');
select is(rpc_media_pair_start(pg_temp.k(1), 'KEY1') ->> 'code', (select v ->> 'code' from t_c where k = 'p1'), 'asking again gives the same code');
select is(rpc_media_pair_poll(pg_temp.k(1)) ->> 'status', 'waiting', 'waiting until the owner types it');
select throws_ok($$select rpc_media_pair_start('short', 'KEY1')$$, '23514', null, 'a malformed request is refused');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select is(rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc',
  lpad(((select (v ->> 'code')::int from t_c where k = 'p1') + 1) % 1000000 || '', 6, '0'), 'Speaker') ->> 'error',
  'GDPCN', 'a wrong code says so');
insert into t_c values ('s1', rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc',
  (select regexp_replace(v ->> 'code', '(\d{3})(\d{3})', '\1 \2') from t_c where k = 'p1'), '  Living room  '));
select is((select v ->> 'ok' from t_c where k = 's1'), 'true', 'the right code (typed with a space) pairs the speaker');
reset role;
create function pg_temp.dev() returns uuid language sql stable as $$ select (v ->> 'id')::uuid from t_c where k = 's1' $$;
select is((select kind || '|' || name || '|' || token_hint || '|' || (settings ->> 'volume_max') from device where id = pg_temp.dev()),
  'media|Living room|KEY1|80', 'a speaker with the Pi''s key hint and default settings');
select is((select count(*)::int from device_pairing where token_hash = pg_temp.k(1)), 0, 'the pairing is used up');
set local role service_role;
select is(rpc_media_pair_poll(pg_temp.k(1)) ->> 'status', 'paired', 'the Pi learns it is paired');
select is(rpc_media_pair_start(pg_temp.k(1), 'KEY1') ->> 'status', 'paired', 'and starting again says so');
select is(rpc_media_pair_poll(pg_temp.k(1)) ->> 'household', 'Music C', '… with the household it joined (shown on the PC)');
insert into t_c values ('s5', rpc_media_pair_start(pg_temp.k(5), 'KEY5', null, repeat('f', 64)));
insert into t_c values ('s6', rpc_media_pair_start(pg_temp.k(6), 'KEY6', null, repeat('f', 64)));
insert into t_c values ('s7', rpc_media_pair_start(pg_temp.k(7), 'KEY7', null, repeat('f', 64)));
select throws_ok(format($$select rpc_media_pair_start(%L, 'KEY8', null, %L)$$, pg_temp.k(8), repeat('f', 64)), 'GDRTE', null,
  'one caller can''t keep more than 3 pairings waiting');
insert into t_c values ('p2', rpc_media_pair_start(pg_temp.k(2), 'KEY2'));
insert into t_c values ('p3', rpc_media_pair_start(pg_temp.k(3), 'KEY3'));
reset role;
insert into device_pair_attempt (household_id) select '00000000-0000-0000-0000-0000000f7ccc' from generate_series(1, 9);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select throws_ok(format($$select rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc', %L, 'Bedroom')$$,
  (select v ->> 'code' from t_c where k = 'p2')), 'GDRTE', null, 'after 10 wrong codes in 10 minutes it waits');
reset role;
delete from device_pair_attempt where household_id = '00000000-0000-0000-0000-0000000f7ccc';
insert into device_pair_attempt (household_id) select '00000000-0000-0000-0000-0000000f7ddd' from generate_series(1, 30);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select throws_ok($$select rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc', '000000', 'Guess')$$, 'GDRTE', null,
  '30 wrong codes from anyone in 10 minutes stop all guessing');
reset role;
delete from device_pair_attempt where household_id = '00000000-0000-0000-0000-0000000f7ddd';
update device_pairing set expires_at = now() - interval '1 second' where token_hash = pg_temp.k(3);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select is(rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc', (select v ->> 'code' from t_c where k = 'p3'), 'Old') ->> 'error',
  'GDPCN', 'an expired code no longer works');
insert into t_c values ('s2', rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc', (select v ->> 'code' from t_c where k = 'p2'), 'Bedroom'));
reset role;
set local role service_role;
insert into t_c values ('p4', rpc_media_pair_start(pg_temp.k(4), 'KEY4'));
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select throws_ok(format($$select rpc_device_pair('00000000-0000-0000-0000-0000000f7ccc', %L, 'Third')$$,
  (select v ->> 'code' from t_c where k = 'p4')), '23514', null, 'at most 2 speakers');

-- ── Settings ──────────────────────────────────────────────────────────────────
select lives_ok(format($$select rpc_device_update(%L, '{"settings":{"volume_max":60,"fade_s":12}}')$$, pg_temp.dev()), 'speaker settings save');
select throws_ok(format($$select rpc_device_update(%L, '{"settings":{"volume":60}}')$$, pg_temp.dev()), '23514', null,
  'a scale''s setting is refused on a speaker');

-- ── Uploads ───────────────────────────────────────────────────────────────────
insert into t_c values ('u1', rpc_media_upload_begin(pg_temp.dev(), format('{"title":" Rain ","artist":"Nature","size_bytes":1000,"sha256":"%s","mime":"audio/mpeg","file_name":"rain.mp3"}', repeat('a', 64))::jsonb));
select is((select v ->> 'inbox_path' from t_c where k = 'u1'), '00000000-0000-0000-0000-0000000f7ccc/' || (select v ->> 'id' from t_c where k = 'u1'),
  'the upload goes to the household''s inbox folder');
select is(rpc_media_upload_begin(pg_temp.dev(), format('{"title":"Rain again","size_bytes":1000,"sha256":"%s","mime":"audio/mpeg"}', repeat('A', 64))::jsonb) ->> 'status',
  'duplicate', 'the same file (by sha256) isn''t sent twice');
select throws_ok(format($$select rpc_media_upload_begin(%L, '{"title":"Big","size_bytes":70000000,"sha256":"%s","mime":"audio/flac"}')$$, pg_temp.dev(), repeat('b', 64)),
  '23514', null, 'a song over 60 MB is refused');
select throws_ok(format($$select rpc_media_upload_begin(%L, '{"title":"Odd","size_bytes":10,"sha256":"%s","mime":"video/mp4"}')$$, pg_temp.dev(), repeat('b', 64)),
  '23514', null, 'only audio types');
select throws_ok(format($$select rpc_media_upload_done(%L)$$, (select v ->> 'id' from t_c where k = 'u1')), '23514', null,
  '"done" before the file is in the inbox is refused');
reset role;
insert into storage.objects (bucket_id, name, metadata)
  select 'media-inbox', v ->> 'inbox_path', '{"size": 1000}' from t_c where k = 'u1';
-- 300 MB already on its way for this household:
insert into media_track (household_id, device_id, title, size_bytes, sha256, mime, source, state, inbox_path, updated_at) values
  ('00000000-0000-0000-0000-0000000f7ccc', pg_temp.dev(), 'Big wait', 314572000, repeat('c', 64), 'audio/flac', 'upload', 'waiting',
   '00000000-0000-0000-0000-0000000f7ccc/big', now() - interval '4 days');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select is(rpc_media_upload_done((select (v ->> 'id')::uuid from t_c where k = 'u1')) ->> 'state', 'waiting', 'a complete upload waits for the speaker');
select throws_ok(format($$select rpc_media_upload_begin(%L, '{"title":"One more","size_bytes":5000,"sha256":"%s","mime":"audio/mpeg"}')$$, pg_temp.dev(), repeat('d', 64)),
  'GDMQF', null, 'over 300 MB waiting: the browser has to wait');
reset role;

-- ── The speaker's sync ────────────────────────────────────────────────────────
set local role service_role;
insert into t_c values ('y1', rpc_media_sync(pg_temp.k(1), '{"agent":"gedara-media 0.1.0","up":10,"status":{"output":"usb"}}'));
select is((select jsonb_array_length(v -> 'downloads') from t_c where k = 'y1'), 2, 'both waiting songs are handed out');
select is(jsonb_array_length(rpc_media_sync(pg_temp.k(1), '{"agent":"gedara-media 0.1.0","up":11}') -> 'downloads'), 0,
  '… once (not again on the next sync)');
select ok((select v ? 'settings' and v ? 'schedules' from t_c where k = 'y1'), 'the first sync gets settings and schedules');
select lives_ok(format($$select rpc_media_sync(%L, '{"agent":"a","up":12,"downloaded":[{"id":"%s","ok":true,"file":"inbox/%s.mp3"}],
  "player":{"state":"playing","track_id":"%s","elapsed_s":3.5,"duration_s":180,"volume":40,"shuffle":false,"repeat":"off","queue":["%s"],"queue_index":0},
  "played":[{"id":"%s","at_ms":1760000000000}]}')$$,
  pg_temp.k(1), (select v ->> 'id' from t_c where k = 'u1'), (select v ->> 'id' from t_c where k = 'u1'),
  (select v ->> 'id' from t_c where k = 'u1'), (select v ->> 'id' from t_c where k = 'u1'), (select v ->> 'id' from t_c where k = 'u1')),
  'the speaker reports a download, its player and a play');
reset role;
select is((select state || '|' || on_device || '|' || device_file || '|' || coalesce(inbox_path, '-') || '|' || plays
             from media_track where id = (select (v ->> 'id')::uuid from t_c where k = 'u1')),
  'ready|true|inbox/' || (select v ->> 'id' from t_c where k = 'u1') || '.mp3|-|1', 'downloaded → ready on the card, played once');
select is((select count(*)::int from media_inbox_trash where path = (select v ->> 'inbox_path' from t_c where k = 'u1')), 1,
  'its inbox copy is queued for deletion');
select is((select state || '|' || volume from media_player where device_id = pg_temp.dev()), 'playing|40', 'the player state is stored');
set local role service_role;
select ok((rpc_media_sync(pg_temp.k(1), '{"agent":"a","up":13}') -> 'trash') ? (select v ->> 'inbox_path' from t_c where k = 'u1'),
  'the function is told to delete it from Storage');
select is(rpc_media_trash_done(pg_temp.k(1), array[(select v ->> 'inbox_path' from t_c where k = 'u1')]), 1, '… and confirms');

-- Folder songs.
select lives_ok(format($$select rpc_media_sync(%L, '{"agent":"a","up":14,"pc_added":[
  {"sha256":"%s","file":"pc/Calm/01 Forest.mp3","size_bytes":4000,"mime":"audio/mpeg","title":"Forest","artist":"Calm","album":"Calm","track_no":1,"duration_s":200},
  {"sha256":"%s","file":"pc/Big.flac","size_bytes":314572000,"mime":"audio/flac","title":"Big wait"}]}')$$,
  pg_temp.k(1), repeat('e', 64), repeat('c', 64)), 'the speaker reports two songs from the PC folder');
reset role;
select is((select source || '|' || state || '|' || file_name from media_track where sha256 = repeat('e', 64)), 'pc|ready|01 Forest.mp3',
  'a new folder song is ready at once');
select is((select state || '|' || device_file || '|' || coalesce(inbox_path, '-') from media_track where sha256 = repeat('c', 64)),
  'ready|pc/Big.flac|-', 'a folder copy of a song still on its way finishes it');

-- ── Commands ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
insert into t_c values ('c1', jsonb_build_object('id', rpc_media_command(pg_temp.dev(), 'play', jsonb_build_object('track_ids', jsonb_build_array(
  (select id from media_track where sha256 = repeat('d', 64) limit 1),      -- not there (never uploaded) → null, dropped
  (select id from media_track where sha256 = repeat('a', 64)),
  (select id from media_track where sha256 = repeat('e', 64))), 'index', 2))));
reset role;
select is((select jsonb_array_length(args -> 'queue') || '|' || (args ->> 'index') || '|' || (args -> 'queue' -> 1 ->> 'file')
             from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'c1')),
  '2|1|pc/Calm/01 Forest.mp3', 'play: only songs on the card, as files, the index still on the chosen song');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
insert into t_c values ('v1', jsonb_build_object('id', rpc_media_command(pg_temp.dev(), 'volume', '{"v":90}')));
reset role;
select is((select args ->> 'v' from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'v1')), '60',
  'the volume is capped at the speaker''s limit (60)');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select is(rpc_media_command(pg_temp.dev(), 'volume', '{"v":30}'), (select (v ->> 'id')::uuid from t_c where k = 'v1'),
  'a second volume change replaces the one still waiting');
reset role;
select is((select args ->> 'v' from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'v1')), '30', '… with the latest value');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
insert into t_c values ('v2', jsonb_build_object('id', rpc_media_command(pg_temp.dev(), 'pause')));
select throws_ok(format($$select rpc_media_command(%L, 'dance')$$, pg_temp.dev()), '23514', null, 'an unknown command is refused');
select throws_ok(format($$select rpc_media_command(%L, 'play', '{"track_ids":[]}')$$, pg_temp.dev()), '23514', null, 'nothing to play is refused');
select ok(rpc_media_command(pg_temp.dev(), 'sleep', '{"minutes":30}') is not null, 'a sleep timer is accepted');
reset role;
select is((select args ->> 'fade_s' from media_command where command = 'sleep' and device_id = pg_temp.dev()), '12', 'it carries the speaker''s fade');
update media_command set created_at = now() - interval '2 minutes' where id = (select (v ->> 'id')::uuid from t_c where k = 'v2');
set local role service_role;
insert into t_c values ('pend', rpc_media_pending(pg_temp.k(1)));
reset role;
select is((select status from media_command where id = (select (v ->> 'id')::uuid from t_c where k = 'v2')), 'expired',
  'a command nobody picked up within 60 s expires');
select is((select count(*)::int from jsonb_array_elements((select v -> 'commands' from t_c where k = 'pend'))), 3,
  'the speaker gets the play, volume and sleep commands, in order, once');

-- ── Playlists, schedules, delete ──────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
insert into media_playlist (id, household_id, name) values ('00000000-0000-0000-0000-00000007c0b1', '00000000-0000-0000-0000-0000000f7ccc', 'Relax');
select is(rpc_media_playlist_set('00000000-0000-0000-0000-00000007c0b1', array[
  (select id from media_track where sha256 = repeat('e', 64)), (select id from media_track where sha256 = repeat('a', 64)),
  (select id from media_track where sha256 = repeat('e', 64))]), 2, 'a playlist keeps each song once, in order');
insert into media_schedule (household_id, device_id, name, start_time, playlist_id, volume, stop_after_min)
  values ('00000000-0000-0000-0000-0000000f7ccc', pg_temp.dev(), 'Wind down', '21:30', '00000000-0000-0000-0000-00000007c0b1', 90, 45);
reset role;
set local role service_role;
insert into t_c values ('y2', rpc_media_sync(pg_temp.k(1), '{"agent":"a","up":20}'));
select is((select v -> 'schedules' -> 0 ->> 'volume' || '|' || (v -> 'schedules' -> 0 -> 'tracks' -> 0 ->> 'file') from t_c where k = 'y2'),
  '60|pc/Calm/01 Forest.mp3', 'the schedule reaches the speaker with its songs and the volume limit');
select ok(not (rpc_media_sync(pg_temp.k(1), jsonb_build_object('agent', 'a', 'up', 21, 'known',
  jsonb_build_object('schedules_v', (select v ->> 'schedules_v' from t_c where k = 'y2'),
                     'settings_v', (select (v ->> 'settings_v') from t_c where k = 'y2')))) ? 'schedules'),
  'unchanged schedules aren''t sent again');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7c01","role":"authenticated"}';
select is(rpc_media_track_delete(array[(select id from media_track where sha256 = repeat('e', 64))]), 1, 'delete a song on the card');
reset role;
select is((select state || '|' || (select count(*) from media_playlist_item i where i.track_id = t.id)
             from media_track t where sha256 = repeat('e', 64)), 'deleting|0', '… it waits for the speaker and leaves the playlist');
set local role service_role;
select is((rpc_media_sync(pg_temp.k(1), '{"agent":"a","up":22}') -> 'deletions' -> 0 ->> 'file'), 'pc/Calm/01 Forest.mp3', 'the speaker is told which file');
select lives_ok(format($$select rpc_media_sync(%L, '{"agent":"a","up":23,"deleted":["%s"]}')$$, pg_temp.k(1),
  (select id from media_track where sha256 = repeat('e', 64))), 'it reports the file gone');
reset role;
select is((select count(*)::int from media_track where sha256 = repeat('e', 64)), 0, '… and the song is gone');

-- ── Housekeeping ──────────────────────────────────────────────────────────────
insert into media_track (household_id, device_id, title, size_bytes, sha256, mime, source, state, inbox_path, updated_at) values
  ('00000000-0000-0000-0000-0000000f7ccc', pg_temp.dev(), 'Abandoned', 10, repeat('f', 64), 'audio/mpeg', 'upload', 'uploading',
   '00000000-0000-0000-0000-0000000f7ccc/abandoned', now() - interval '2 days');
do $$ begin perform private.housekeeping(); end $$;
select is((select count(*)::int from media_track where sha256 = repeat('f', 64)), 0, 'an upload abandoned for a day is forgotten');
select is((select count(*)::int from media_inbox_trash where path = '00000000-0000-0000-0000-0000000f7ccc/abandoned'), 1, '… and its file queued for deletion');

select * from finish();
rollback;
