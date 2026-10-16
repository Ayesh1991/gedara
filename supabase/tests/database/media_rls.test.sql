-- Phase 7h RLS: another household can't read or change my speaker, its songs, playlists, schedules,
-- player or commands, can't upload to it, command it, pair into my household or touch my cover art /
-- inbox files. Speaker keys, waiting pairings, wrong-code tries and the inbox trash are unreadable to
-- everyone but SECURITY DEFINER code. Only the owner pairs or removes a speaker; a member may
-- command it and edit playlists; a viewer only reads. The speaker RPCs are for the service role only,
-- a speaker's key only ever sees its own speaker, a scale key can't act as a speaker (nor the other
-- way round), and anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.h(p_token text) returns text language sql immutable as
  $$ select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7a01', 'p7hrls-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7a02', 'p7hrls-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7a03', 'p7hrls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7b01', 'p7hrls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f7aaa', 'Music RLS A'),
  ('00000000-0000-0000-0000-0000000f7bbb', 'Music RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f7aaa', '00000000-0000-0000-0000-0000000f7a01', 'owner'),
  ('00000000-0000-0000-0000-0000000f7aaa', '00000000-0000-0000-0000-0000000f7a02', 'member'),
  ('00000000-0000-0000-0000-0000000f7aaa', '00000000-0000-0000-0000-0000000f7a03', 'viewer'),
  ('00000000-0000-0000-0000-0000000f7bbb', '00000000-0000-0000-0000-0000000f7b01', 'owner');

-- Both speakers pair: the Pi asks for a code (service role), the owner types it.
set local role service_role;
insert into t_c values ('pa', rpc_media_pair_start(pg_temp.h('speaker-key-a-0000000000000000000000000000'), 'KEYA', 'gedara-media 0.1.0'));
insert into t_c values ('pb', rpc_media_pair_start(pg_temp.h('speaker-key-b-0000000000000000000000000000'), 'KEYB', 'gedara-media 0.1.0'));
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7a01","role":"authenticated"}';
insert into t_c values ('a', rpc_device_pair('00000000-0000-0000-0000-0000000f7aaa', (select v ->> 'code' from t_c where k = 'pa'), 'Speaker A'));
insert into t_c values ('scale', rpc_device_create('00000000-0000-0000-0000-0000000f7aaa', 'Scale A'));
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7b01","role":"authenticated"}';
insert into t_c values ('b', rpc_device_pair('00000000-0000-0000-0000-0000000f7bbb', (select v ->> 'code' from t_c where k = 'pb'), 'Speaker B'));
reset role;

create function pg_temp.dev(p_k text) returns uuid language sql stable as $$ select (v ->> 'id')::uuid from t_c where k = p_k $$;

-- A's library (as the migration owner).
insert into media_track (id, household_id, device_id, title, size_bytes, sha256, mime, source, state, on_device, device_file) values
  ('00000000-0000-0000-0000-00000007a0a1', '00000000-0000-0000-0000-0000000f7aaa', pg_temp.dev('a'), 'Rain A', 1000,
   repeat('1', 64), 'audio/mpeg', 'upload', 'ready', true, 'inbox/a1.mp3'),
  ('00000000-0000-0000-0000-00000007a0a2', '00000000-0000-0000-0000-0000000f7aaa', pg_temp.dev('a'), 'Waves A', 1000,
   repeat('2', 64), 'audio/mpeg', 'upload', 'waiting', false, null);
insert into media_playlist (id, household_id, name) values
  ('00000000-0000-0000-0000-00000007a0b1', '00000000-0000-0000-0000-0000000f7aaa', 'Relax A');
insert into media_playlist_item (household_id, playlist_id, track_id, position) values
  ('00000000-0000-0000-0000-0000000f7aaa', '00000000-0000-0000-0000-00000007a0b1', '00000000-0000-0000-0000-00000007a0a1', 0);
insert into media_schedule (id, household_id, device_id, name, start_time) values
  ('00000000-0000-0000-0000-00000007a0c1', '00000000-0000-0000-0000-0000000f7aaa', pg_temp.dev('a'), 'Wind down A', '21:30');
insert into media_player (device_id, household_id, state) values (pg_temp.dev('a'), '00000000-0000-0000-0000-0000000f7aaa', 'paused');
insert into media_command (id, household_id, device_id, command) values
  ('00000000-0000-0000-0000-00000007a0d1', '00000000-0000-0000-0000-0000000f7aaa', pg_temp.dev('a'), 'pause'),
  ('00000000-0000-0000-0000-00000007b0d1', '00000000-0000-0000-0000-0000000f7bbb', pg_temp.dev('b'), 'pause');
insert into storage.objects (bucket_id, name, metadata) values
  ('media-art', '00000000-0000-0000-0000-0000000f7aaa/a1.webp', '{"size": 2000}');

-- ── Owner B ───────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7b01","role":"authenticated"}';
select is((select count(*)::int from media_track), 0, 'B can''t see A''s songs');
select is((select count(*)::int from media_playlist), 0, 'B can''t see A''s playlists');
select is((select count(*)::int from media_playlist_item), 0, 'B can''t see A''s playlist songs');
select is((select count(*)::int from media_schedule), 0, 'B can''t see A''s schedules');
select is((select count(*)::int from media_player), 0, 'B can''t see A''s player');
select is((select count(*)::int from media_command where household_id <> '00000000-0000-0000-0000-0000000f7bbb'), 0, 'B can''t see A''s commands');
select is((select count(*)::int from storage.objects where bucket_id = 'media-art'), 0, 'B can''t see A''s cover art');
select throws_ok(format($$select rpc_media_command(%L, 'pause')$$, pg_temp.dev('a')), '42501', null, 'B can''t command A''s speaker');
select throws_ok(format($$select rpc_media_upload_begin(%L, '{"title":"x","size_bytes":10,"sha256":"%s","mime":"audio/mpeg"}')$$,
  pg_temp.dev('a'), repeat('9', 64)), '42501', null, 'B can''t upload to A''s speaker');
select throws_ok($$insert into media_playlist (household_id, name) values ('00000000-0000-0000-0000-0000000f7aaa', 'Sneaky')$$,
  '42501', null, 'B can''t add a playlist to A');
select throws_ok(format($$insert into media_schedule (household_id, device_id, name, start_time)
  values ('00000000-0000-0000-0000-0000000f7bbb', %L, 'Mine now', '06:00')$$, pg_temp.dev('a')),
  '23514', null, 'B can''t put a schedule on A''s speaker');
update media_playlist set name = 'Hacked' where id = '00000000-0000-0000-0000-00000007a0b1';
delete from media_schedule where id = '00000000-0000-0000-0000-00000007a0c1';
select throws_ok($$select rpc_media_playlist_set('00000000-0000-0000-0000-00000007a0b1', '{}')$$, '42501', null, 'B can''t reorder A''s playlist');
select throws_ok($$select rpc_media_track_update('00000000-0000-0000-0000-00000007a0a1', '{"title":"Mine"}')$$, '42501', null, 'B can''t rename A''s song');
select throws_ok($$select rpc_media_track_delete(array['00000000-0000-0000-0000-00000007a0a1'::uuid])$$, '42501', null, 'B can''t delete A''s song');
select throws_ok($$select rpc_media_upload_done('00000000-0000-0000-0000-00000007a0a2')$$, '42501', null, 'B can''t finish A''s upload');
select throws_ok($$select rpc_device_pair('00000000-0000-0000-0000-0000000f7aaa', '123456', 'X')$$, '42501', null, 'B can''t pair into A');
select throws_ok(format($$select rpc_device_revoke(%L)$$, pg_temp.dev('a')), '42501', null, 'B can''t remove A''s speaker');
select throws_ok(format($$select rpc_device_update(%L, '{"settings":{"volume_max":100}}')$$, pg_temp.dev('a')), '42501', null, 'B can''t change A''s speaker settings');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('media-art', '00000000-0000-0000-0000-0000000f7aaa/b.webp')$$, '42501', null, 'B can''t put cover art in A''s folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('media-inbox', '00000000-0000-0000-0000-0000000f7aaa/00000000-0000-0000-0000-00000007a0a2')$$, '42501', null, 'B can''t upload into A''s inbox');
reset role;
select is((select name from media_playlist where id = '00000000-0000-0000-0000-00000007a0b1'), 'Relax A', 'B''s update didn''t touch A''s playlist');
select is((select count(*)::int from media_schedule where id = '00000000-0000-0000-0000-00000007a0c1'), 1, 'B''s delete didn''t touch A''s schedule');

-- ── A's viewer, member, owner ─────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7a03","role":"authenticated"}';
select is((select count(*)::int from media_track), 2, 'A''s viewer sees A''s songs');
select throws_ok(format($$select rpc_media_command(%L, 'pause')$$, pg_temp.dev('a')), '42501', null, 'a viewer can''t command the speaker');
select throws_ok($$insert into media_playlist (household_id, name) values ('00000000-0000-0000-0000-0000000f7aaa', 'Viewer list')$$,
  '42501', null, 'a viewer can''t add a playlist');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7a02","role":"authenticated"}';
select lives_ok(format($$select rpc_media_command(%L, 'pause')$$, pg_temp.dev('a')), 'a member commands the speaker');
select throws_ok($$select rpc_device_pair('00000000-0000-0000-0000-0000000f7aaa', '123456', 'Member speaker')$$, '42501', null, 'only the owner pairs a speaker');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7a01","role":"authenticated"}';
select throws_ok($$select count(*) from media_token$$, '42501', null, 'speaker keys are unreadable');
select throws_ok($$select count(*) from device_pairing$$, '42501', null, 'waiting pairings are unreadable');
select throws_ok($$select count(*) from device_pair_attempt$$, '42501', null, 'wrong-code tries are unreadable');
select throws_ok($$select count(*) from media_inbox_trash$$, '42501', null, 'the inbox trash is unreadable');
select throws_ok(format($$select rpc_media_sync(%L, '{}')$$, pg_temp.h('speaker-key-a-0000000000000000000000000000')), '42501', null, 'users can''t call the speaker''s sync');
select throws_ok(format($$select rpc_media_pair_start(%L, 'ABCD')$$, repeat('c', 64)), '42501', null, 'users can''t start a pairing');
reset role;
set local role anon;
select throws_ok($$select count(*) from media_track$$, '42501', null, 'anon sees no songs');
reset role;

-- ── Speaker keys ──────────────────────────────────────────────────────────────
set local role service_role;
select is((rpc_media_sync(pg_temp.h('speaker-key-a-0000000000000000000000000000'), '{"agent":"t","up":1}') ->> 'device_id')::uuid,
  pg_temp.dev('a'), 'A''s key syncs as A''s speaker');
select is((select count(*)::int from jsonb_array_elements(rpc_media_sync(pg_temp.h('speaker-key-b-0000000000000000000000000000'),
  format('{"agent":"t","up":1,"done":[{"id":"%s","ok":true}],"downloaded":[{"id":"00000000-0000-0000-0000-00000007a0a2","ok":true,"file":"x"}],"deleted":["00000000-0000-0000-0000-00000007a0a1"]}',
         '00000000-0000-0000-0000-00000007a0d1')::jsonb) -> 'commands') c
  where (c ->> 'id')::uuid = '00000000-0000-0000-0000-00000007a0d1'), 0, 'B''s key never gets A''s commands');
reset role;
select is((select status from media_command where id = '00000000-0000-0000-0000-00000007a0d1'), 'sent',
  'B''s key can''t mark A''s command done (A''s own sync sent it)');
select is((select state || '/' || count(*) over () from media_track where id in ('00000000-0000-0000-0000-00000007a0a1', '00000000-0000-0000-0000-00000007a0a2')
            order by id limit 1), 'ready/2', 'B''s key can''t report or delete A''s songs');
set local role service_role;
select throws_ok(format($$select rpc_media_sync(%L, '{"agent":"t","up":1}')$$,
  encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = 'scale'), 'UTF8'), 'sha256'), 'hex')),
  '42501', null, 'a scale''s key can''t act as a speaker');
select throws_ok(format($$select rpc_scale_sync(%L, '{"v":1,"fw":"x","epoch":1,"boot":1,"up":1}')$$,
  pg_temp.h('speaker-key-a-0000000000000000000000000000')), '42501', null, 'a speaker''s key can''t act as a scale');

select * from finish();
rollback;
