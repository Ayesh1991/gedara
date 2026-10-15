-- Phase 7h · 72 — the speaker's player: what it's doing now (media_player, live over Realtime), the
-- commands Gedara sends it (media_command), and its one conversation with Gedara (rpc_media_sync,
-- service role only, called by the media-agent Edge Function with the speaker's key hash).
--
-- A command is resolved here into exactly what the speaker needs (a play command carries the queue
-- as [{id, file}] of songs that are on its SD card), so the speaker never looks anything up. A
-- command not picked up within 60 s expires: nobody wants a song to start minutes late.

create table public.media_player (
  device_id    uuid primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  state        text not null default 'stopped' check (state in ('stopped', 'playing', 'paused')),
  track_id     uuid references public.media_track (id) on delete set null,
  elapsed_s    numeric(9,3) not null default 0 check (elapsed_s >= 0),
  duration_s   numeric(9,3) check (duration_s >= 0),
  at           timestamptz not null default now(),          -- when elapsed_s was true (received time)
  volume       integer not null default 50 check (volume between 0 and 100),
  sleep_until  timestamptz,
  shuffle      boolean not null default false,
  repeat       text not null default 'off' check (repeat in ('off', 'all', 'one')),
  queue        uuid[] not null default '{}' check (cardinality(queue) <= 500),
  queue_index  integer check (queue_index >= 0),
  updated_at   timestamptz not null default now(),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade
);
create index media_player_household_idx on public.media_player (household_id);
create index media_player_track_idx on public.media_player (track_id);

create table public.media_command (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  command      text not null check (command in ('play', 'pause', 'resume', 'stop', 'next', 'prev', 'seek',
                 'volume', 'sleep', 'shuffle', 'repeat', 'queue_add', 'queue_move', 'queue_remove',
                 'test_tone', 'rescan')),
  args         jsonb not null default '{}' check (jsonb_typeof(args) = 'object'),
  status       text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'expired')),
  error        text check (length(error) <= 200),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz,
  unique (household_id, id),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade
);
create index media_command_open_idx on public.media_command (device_id, created_at) where status = 'queued';
create index media_command_household_idx on public.media_command (household_id, created_at desc);
create index media_command_device_idx on public.media_command (device_id);
create index media_command_created_by_idx on public.media_command (created_by);

alter table public.media_player enable row level security;
alter table public.media_command enable row level security;
revoke all on table public.media_player, public.media_command from anon, authenticated;
grant select on table public.media_player, public.media_command to authenticated;
create policy media_player_select on public.media_player
  for select to authenticated using (private.is_member(household_id));
create policy media_command_select on public.media_command
  for select to authenticated using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.media_player;
    alter publication supabase_realtime add table public.media_command;
  end if;
end;
$$;

-- Songs of this speaker that are on its card, as [{id, file}] in the order given.
create function private.media_queue(p_device uuid, p_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'file', t.device_file) order by u.ord), '[]'::jsonb)
    from unnest(p_ids) with ordinality as u (id, ord)
    join public.media_track t on t.id = u.id and t.device_id = p_device and t.state = 'ready' and t.on_device
$$;
revoke execute on function private.media_queue(uuid, uuid[]) from public, anon, authenticated;

create function private.json_uuids(p jsonb, p_max integer)
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > p_max then
    raise exception 'at most % songs', p_max using errcode = '23514';
  end if;
  return (select coalesce(array_agg(e::uuid order by o), '{}') from jsonb_array_elements_text(p) with ordinality as x (e, o));
end;
$$;
revoke execute on function private.json_uuids(jsonb, integer) from public, anon, authenticated;

-- ── Commands from Gedara ──────────────────────────────────────────────────────
-- play       { track_ids?: uuid[] ≤ 500, index?: int, playlist_id?: uuid, shuffle?: bool }
-- seek { s } · volume { v } · sleep { minutes 0–240 (0 = off), end_of_track? } · shuffle { on }
-- repeat { mode: off|all|one } · queue_add { track_ids ≤ 200, next? } · queue_move { from, to }
-- queue_remove { index } · pause · resume · stop · next · prev · test_tone · rescan
create function public.rpc_media_command(p_device uuid, p_command text, p_args jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev   public.device%rowtype := private.media_device(p_device);
  v_a     jsonb := coalesce(p_args, '{}'::jsonb);
  v_out   jsonb := '{}'::jsonb;
  v_ids   uuid[];
  v_queue jsonb;
  v_idx   integer;
  v_id    uuid;
  v_max   integer := coalesce((v_dev.settings ->> 'volume_max')::integer, 100);
begin
  if jsonb_typeof(v_a) <> 'object' then
    raise exception 'args must be an object' using errcode = '23514';
  end if;
  if (select count(*) from public.media_command c
       where c.device_id = p_device and c.created_at > now() - interval '1 minute') >= 120 then
    raise exception 'too many commands' using errcode = 'GDRTE';
  end if;

  case p_command
    when 'play' then
      if v_a ? 'playlist_id' then
        select coalesce(array_agg(i.track_id order by i.position), '{}') into v_ids
          from public.media_playlist_item i join public.media_playlist pl on pl.id = i.playlist_id
         where i.playlist_id = (v_a ->> 'playlist_id')::uuid and pl.household_id = v_dev.household_id;
      else
        v_ids := private.json_uuids(v_a -> 'track_ids', 500);
      end if;
      v_queue := private.media_queue(p_device, v_ids);
      if jsonb_array_length(v_queue) = 0 then
        raise exception 'nothing to play on this speaker yet' using errcode = '23514';
      end if;
      -- The index points into the songs that are really there (a song still on its way is skipped).
      v_idx := coalesce((v_a ->> 'index')::integer, 0);
      if v_idx < 0 or v_idx >= coalesce(cardinality(v_ids), 0) then v_idx := 0; end if;
      if v_idx > 0 then
        select coalesce(min(q.o) - 1, 0)::integer into v_idx
          from jsonb_array_elements(v_queue) with ordinality as q (e, o)
         where (q.e ->> 'id')::uuid = v_ids[v_idx + 1];
      end if;
      v_out := jsonb_build_object('queue', v_queue, 'index', v_idx,
                                  'shuffle', coalesce((v_a ->> 'shuffle')::boolean, false));
    when 'pause', 'resume', 'stop', 'next', 'prev', 'test_tone', 'rescan' then
      v_out := '{}'::jsonb;
    when 'seek' then
      if (v_a ->> 's')::numeric not between 0 and 86400 then
        raise exception 'seek 0–86400 s' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('s', round((v_a ->> 's')::numeric, 1));
    when 'volume' then
      if (v_a ->> 'v')::integer not between 0 and 100 then
        raise exception 'volume 0–100' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('v', least((v_a ->> 'v')::integer, v_max));
    when 'sleep' then
      if (v_a ->> 'minutes')::integer not between 0 and 240 then
        raise exception 'sleep 0–240 minutes' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('minutes', (v_a ->> 'minutes')::integer,
                                  'end_of_track', coalesce((v_a ->> 'end_of_track')::boolean, false),
                                  'fade_s', coalesce((v_dev.settings ->> 'fade_s')::integer, 8));
    when 'shuffle' then
      v_out := jsonb_build_object('on', coalesce((v_a ->> 'on')::boolean, false));
    when 'repeat' then
      if coalesce(v_a ->> 'mode', '') not in ('off', 'all', 'one') then
        raise exception 'repeat off|all|one' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('mode', v_a ->> 'mode');
    when 'queue_add' then
      v_queue := private.media_queue(p_device, private.json_uuids(v_a -> 'track_ids', 200));
      if jsonb_array_length(v_queue) = 0 then
        raise exception 'nothing to add' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('tracks', v_queue, 'next', coalesce((v_a ->> 'next')::boolean, false));
    when 'queue_move' then
      if (v_a ->> 'from')::integer not between 0 and 499 or (v_a ->> 'to')::integer not between 0 and 499 then
        raise exception 'queue positions 0–499' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('from', (v_a ->> 'from')::integer, 'to', (v_a ->> 'to')::integer);
    when 'queue_remove' then
      if (v_a ->> 'index')::integer not between 0 and 499 then
        raise exception 'queue position 0–499' using errcode = '23514';
      end if;
      v_out := jsonb_build_object('index', (v_a ->> 'index')::integer);
    else
      raise exception 'unknown command' using errcode = '23514';
  end case;

  -- Dragging the volume or position slider sends many: only the last one that hasn't left matters.
  if p_command in ('volume', 'seek') then
    update public.media_command c set args = v_out, created_at = now()
     where c.device_id = p_device and c.command = p_command and c.status = 'queued'
    returning c.id into v_id;
    if v_id is not null then return v_id; end if;
  end if;
  insert into public.media_command (household_id, device_id, command, args)
  values (v_dev.household_id, p_device, p_command, v_out)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.rpc_media_command(uuid, text, jsonb) from public, anon;
grant execute on function public.rpc_media_command(uuid, text, jsonb) to authenticated;

-- ── The speaker's side (service role only) ────────────────────────────────────
create function private.media_device_by_token(p_token_hash text)
returns public.device
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
begin
  select d.* into v_dev from public.media_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null and d.kind = 'media'
   for update of d;
  if not found then
    raise exception 'unknown or removed speaker' using errcode = '42501';
  end if;
  return v_dev;
end;
$$;
revoke execute on function private.media_device_by_token(text) from public, anon, authenticated;

-- Queued commands for the speaker (marked sent) and whether it should sync now (a song is waiting).
-- The function calls this every ~0.7 s while the speaker's long-poll is open.
create function public.rpc_media_pending(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev  public.device%rowtype := private.media_device_by_token(p_token_hash);
  v_cmds jsonb;
begin
  update public.media_command c set status = 'expired'
   where c.device_id = v_dev.id and c.status = 'queued' and c.created_at < now() - interval '60 seconds';
  with picked as (
    update public.media_command c set status = 'sent', sent_at = now()
     where c.device_id = v_dev.id and c.status = 'queued'
    returning c.id, c.command, c.args, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'command', command, 'args', args) order by created_at), '[]')
    into v_cmds from picked;
  return jsonb_build_object(
    'commands', v_cmds,
    'wake', exists (select 1 from public.media_track t where t.device_id = v_dev.id
                     and (t.state = 'waiting' or (t.state = 'deleting' and t.on_device))));
end;
$$;

-- p (Zod-checked by the function, supabase/functions/_shared/media/protocol.ts):
--   { agent, up, status?, player?, done?, downloaded?, deleted?, pc_added?, pc_removed?, played?, art?,
--     known?: { settings_v, schedules_v } }
-- → { device_id, name, commands, downloads, deletions, trash, settings_v, settings?, schedules_v, schedules? }
create function public.rpc_media_sync(p_token_hash text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev       public.device%rowtype := private.media_device_by_token(p_token_hash);
  v_e         jsonb;
  v_pl        jsonb := p -> 'player';
  v_pending   jsonb;
  v_downloads jsonb;
  v_deletions jsonb;
  v_trash     jsonb;
  v_sched     jsonb;
  v_sched_v   text;
  v_out       jsonb;
  v_id        uuid;
begin
  if jsonb_array_length(coalesce(p -> 'pc_added', '[]')) > 20 or jsonb_array_length(coalesce(p -> 'pc_removed', '[]')) > 100
     or jsonb_array_length(coalesce(p -> 'downloaded', '[]')) > 20 or jsonb_array_length(coalesce(p -> 'deleted', '[]')) > 100
     or jsonb_array_length(coalesce(p -> 'played', '[]')) > 20 or jsonb_array_length(coalesce(p -> 'done', '[]')) > 50 then
    raise exception 'too many items in one sync' using errcode = '23514';
  end if;

  update public.device d set
    last_seen_at = now(),
    fw_version = left(p ->> 'agent', 32),
    status = coalesce(p -> 'status', '{}'::jsonb) || jsonb_build_object('up', (p ->> 'up')::bigint)
   where d.id = v_dev.id;

  -- Commands it carried out.
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'done', '[]')) loop
    update public.media_command c set
      status = case when (v_e ->> 'ok')::boolean then 'done' else 'failed' end,
      error = left(v_e ->> 'error', 200), done_at = now()
     where c.id = (v_e ->> 'id')::uuid and c.device_id = v_dev.id and c.status in ('queued', 'sent');
  end loop;

  -- Songs it downloaded (or couldn't): the inbox copy is no longer needed either way.
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'downloaded', '[]')) loop
    insert into public.media_inbox_trash (path, household_id)
    select t.inbox_path, t.household_id from public.media_track t
     where t.id = (v_e ->> 'id')::uuid and t.device_id = v_dev.id and t.inbox_path is not null
       and (v_e ->> 'ok')::boolean
    on conflict do nothing;
    update public.media_track t set
      state = case when (v_e ->> 'ok')::boolean then 'ready' else 'failed' end,
      on_device = (v_e ->> 'ok')::boolean,
      device_file = case when (v_e ->> 'ok')::boolean then left(v_e ->> 'file', 500) else t.device_file end,
      inbox_path = case when (v_e ->> 'ok')::boolean then null else t.inbox_path end,
      error = case when (v_e ->> 'ok')::boolean then null else left(coalesce(v_e ->> 'error', 'download failed'), 200) end,
      updated_at = now()
     where t.id = (v_e ->> 'id')::uuid and t.device_id = v_dev.id and t.state in ('downloading', 'waiting');
  end loop;

  -- Files it removed (after a delete in Gedara).
  delete from public.media_track t
   where t.device_id = v_dev.id and t.state = 'deleting'
     and t.id in (select x::uuid from jsonb_array_elements_text(coalesce(p -> 'deleted', '[]')) x);

  -- Songs dropped into the PC's "Gedara Music" folder.
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'pc_added', '[]')) loop
    select t.id into v_id from public.media_track t
     where t.device_id = v_dev.id and t.sha256 = lower(v_e ->> 'sha256');
    if v_id is not null then
      -- The same file was uploaded in Gedara too: the folder copy is already on the card.
      insert into public.media_inbox_trash (path, household_id)
      select t.inbox_path, t.household_id from public.media_track t where t.id = v_id and t.inbox_path is not null
      on conflict do nothing;
      update public.media_track t set state = 'ready', on_device = true, device_file = left(v_e ->> 'file', 500),
             inbox_path = null, error = null, updated_at = now()
       where t.id = v_id and t.state <> 'deleting';
    else
      insert into public.media_track (household_id, device_id, title, artist, album, track_no, duration_s,
                                      size_bytes, sha256, mime, source, state, on_device, device_file, file_name, added_by)
      values (v_dev.household_id, v_dev.id, left(btrim(v_e ->> 'title'), 200), left(nullif(btrim(v_e ->> 'artist'), ''), 200),
              left(nullif(btrim(v_e ->> 'album'), ''), 200), (v_e ->> 'track_no')::integer, (v_e ->> 'duration_s')::numeric,
              (v_e ->> 'size_bytes')::bigint, lower(v_e ->> 'sha256'), v_e ->> 'mime', 'pc', 'ready', true,
              left(v_e ->> 'file', 500), left(regexp_replace(v_e ->> 'file', '^.*/', ''), 255), null);
    end if;
    v_id := null;
  end loop;
  delete from public.media_track t
   where t.device_id = v_dev.id and t.source = 'pc'
     and t.device_file in (select x from jsonb_array_elements_text(coalesce(p -> 'pc_removed', '[]')) x);

  -- Cover art it uploaded for folder songs (by the song's sha256: the Pi doesn't know Gedara's ids).
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'art', '[]')) loop
    update public.media_track t set art_path = left(v_e ->> 'art_path', 200), updated_at = now()
     where t.sha256 = lower(v_e ->> 'sha256') and t.device_id = v_dev.id
       and (v_e ->> 'art_path') like v_dev.household_id::text || '/%' and (v_e ->> 'art_path') not like '%..%';
  end loop;

  -- Songs it finished playing (or played for 30 s).
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'played', '[]')) loop
    update public.media_track t set plays = t.plays + 1,
           last_played_at = greatest(coalesce(t.last_played_at, '-infinity'), to_timestamp((v_e ->> 'at_ms')::bigint / 1000.0))
     where t.id = (v_e ->> 'id')::uuid and t.device_id = v_dev.id;
  end loop;

  -- What it's doing now.
  if v_pl is not null then
    insert into public.media_player as m (device_id, household_id, state, track_id, elapsed_s, duration_s, at, volume,
                                          sleep_until, shuffle, repeat, queue, queue_index, updated_at)
    values (v_dev.id, v_dev.household_id, v_pl ->> 'state',
            (select t.id from public.media_track t where t.id = (v_pl ->> 'track_id')::uuid and t.device_id = v_dev.id),
            greatest(coalesce((v_pl ->> 'elapsed_s')::numeric, 0), 0), (v_pl ->> 'duration_s')::numeric, now(),
            coalesce((v_pl ->> 'volume')::integer, 50),
            case when v_pl ->> 'sleep_until_ms' is null then null else to_timestamp((v_pl ->> 'sleep_until_ms')::bigint / 1000.0) end,
            coalesce((v_pl ->> 'shuffle')::boolean, false), coalesce(v_pl ->> 'repeat', 'off'),
            coalesce((select array_agg(x::uuid order by o) from jsonb_array_elements_text(v_pl -> 'queue') with ordinality q (x, o)), '{}'),
            (v_pl ->> 'queue_index')::integer, now())
    on conflict (device_id) do update set
      state = excluded.state, track_id = excluded.track_id, elapsed_s = excluded.elapsed_s,
      duration_s = excluded.duration_s, at = excluded.at, volume = excluded.volume, sleep_until = excluded.sleep_until,
      shuffle = excluded.shuffle, repeat = excluded.repeat, queue = excluded.queue,
      queue_index = excluded.queue_index, updated_at = excluded.updated_at;
  end if;

  -- What it should do.
  v_pending := public.rpc_media_pending(p_token_hash);

  with picked as (
    update public.media_track t set state = 'downloading', sent_at = now()
     where t.id in (select t2.id from public.media_track t2
                     where t2.device_id = v_dev.id and t2.inbox_path is not null
                       and (t2.state = 'waiting' or (t2.state = 'downloading' and t2.sent_at < now() - interval '15 minutes'))
                     order by t2.created_at limit 3)
    returning t.id, t.inbox_path, t.sha256, t.size_bytes, t.mime
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'path', inbox_path, 'sha256', sha256,
                                               'size_bytes', size_bytes, 'mime', mime)), '[]')
    into v_downloads from picked;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'file', t.device_file)), '[]') into v_deletions
    from (select t.id, t.device_file from public.media_track t
           where t.device_id = v_dev.id and t.state = 'deleting' and t.on_device limit 100) t;

  select coalesce(jsonb_agg(x.path), '[]') into v_trash
    from (select tr.path from public.media_inbox_trash tr where tr.household_id = v_dev.household_id
           order by tr.created_at limit 50) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'name', s.name, 'days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
           'volume', least(s.volume, coalesce((v_dev.settings ->> 'volume_max')::integer, 100)),
           'stop_after_min', s.stop_after_min, 'fade_s', s.fade_s, 'shuffle', s.shuffle,
           -- No playlist = the whole library (up to 500 songs; the Pi shuffles them if asked).
           'tracks', case when s.playlist_id is null then
                       private.media_queue(v_dev.id, (select coalesce(array_agg(t.id order by t.created_at), '{}')
                                                        from (select t2.id, t2.created_at from public.media_track t2
                                                               where t2.device_id = v_dev.id and t2.state = 'ready'
                                                               order by t2.created_at limit 500) t))
                     else
                       private.media_queue(v_dev.id, (select coalesce(array_agg(i.track_id order by i.position), '{}')
                                                        from public.media_playlist_item i where i.playlist_id = s.playlist_id)) end)
           order by s.start_time), '[]')
    into v_sched from public.media_schedule s where s.device_id = v_dev.id and s.enabled;
  v_sched_v := md5(v_sched::text);

  v_out := jsonb_build_object(
    'device_id', v_dev.id, 'name', v_dev.name,
    'commands', v_pending -> 'commands', 'downloads', v_downloads, 'deletions', v_deletions, 'trash', v_trash,
    'settings_v', v_dev.settings_version, 'schedules_v', v_sched_v, 'tz', 'Asia/Colombo');
  if (p -> 'known' ->> 'settings_v') is distinct from v_dev.settings_version::text then
    v_out := v_out || jsonb_build_object('settings', v_dev.settings);
  end if;
  if (p -> 'known' ->> 'schedules_v') is distinct from v_sched_v then
    v_out := v_out || jsonb_build_object('schedules', v_sched);
  end if;
  return v_out;
end;
$$;

-- The function deleted these inbox objects from Storage.
create function public.rpc_media_trash_done(p_token_hash text, p_paths text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype := private.media_device_by_token(p_token_hash);
  v_n integer;
begin
  delete from public.media_inbox_trash tr where tr.household_id = v_dev.household_id and tr.path = any (p_paths);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.rpc_media_pending(text), public.rpc_media_sync(text, jsonb),
  public.rpc_media_trash_done(text, text[]) from public, anon, authenticated;
grant execute on function public.rpc_media_pending(text), public.rpc_media_sync(text, jsonb),
  public.rpc_media_trash_done(text, text[]) to service_role;

-- ── Housekeeping (migration 67's, plus the speaker) ───────────────────────────
create or replace function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.attention_dismissal d
   where (d.hidden_until is not null and d.hidden_until < current_date - 7)
      or (d.hidden_until is null and d.created_at < now() - interval '180 days');
  delete from public.push_run r where r.run_on < current_date - 180;
  delete from cron.job_run_details j where j.end_time < now() - interval '30 days';

  -- Kitchen scale (Phase 6b)
  update public.device d set seq_floor = greatest(d.seq_floor, x.max_seq)
    from (select s.device_id, max(s.seq) as max_seq
            from public.scale_reading s
            join public.device d2 on d2.id = s.device_id and s.epoch = d2.epoch
           where s.received_at < now() - interval '90 days' and s.status <> 'needs_decision'
           group by s.device_id) x
   where d.id = x.device_id;
  delete from public.scale_reading s
   where s.received_at < now() - interval '90 days' and s.status <> 'needs_decision';
  delete from public.device_command c where c.created_at < now() - interval '30 days';

  -- Music speaker (Phase 7h)
  delete from public.media_command c where c.created_at < now() - interval '7 days';
  delete from public.device_pairing p where p.expires_at < now();
  delete from public.device_pair_attempt a where a.at < now() - interval '1 day';
  -- An upload abandoned halfway, and songs the speaker never collected.
  insert into public.media_inbox_trash (path, household_id)
  select t.inbox_path, t.household_id from public.media_track t
   where t.inbox_path is not null
     and ((t.state = 'uploading' and t.updated_at < now() - interval '1 day')
       or (t.state in ('waiting', 'downloading') and t.updated_at < now() - interval '3 days'))
  on conflict do nothing;
  delete from public.media_track t where t.state = 'uploading' and t.updated_at < now() - interval '1 day';
  update public.media_track t set state = 'failed', inbox_path = null,
         error = 'the speaker did not collect it within 3 days', updated_at = now()
   where t.state in ('waiting', 'downloading') and t.updated_at < now() - interval '3 days';
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;

update public.app_meta set value = '72' where key = 'schema_version';
