-- Phase 7h · 71 — the speaker's music library, playlists and wind-down schedules.
--
-- A song uploaded in Gedara goes into the private bucket `media-inbox` only until the speaker has
-- downloaded it and checked its sha256; then the media-agent function deletes it (paths queue up in
-- `media_inbox_trash`), so Storage holds at most about 300 MB of songs on their way (GDMQF above
-- that: the browser waits). Songs dropped into the PC's "Gedara Music" folder are reported by the
-- speaker itself (source 'pc') and never touch Storage. Cover art: 320 px WebP in `media-art`.
--
-- state: uploading (browser sending) → waiting (in the inbox) → downloading (link given to the
-- speaker) → ready (on the speaker's SD card) · failed · deleting (the speaker removes the file).

create table public.media_track (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  device_id      uuid not null,
  title          text not null check (length(btrim(title)) between 1 and 200),
  artist         text check (length(artist) <= 200),
  album          text check (length(album) <= 200),
  track_no       integer check (track_no between 0 and 999),
  duration_s     numeric(9,3) check (duration_s >= 0 and duration_s < 86400),
  size_bytes     bigint not null check (size_bytes between 1 and 2147483647),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime           text not null check (mime in ('audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/ogg', 'audio/wav')),
  source         text not null check (source in ('upload', 'pc')),
  state          text not null default 'uploading'
                   check (state in ('uploading', 'waiting', 'downloading', 'ready', 'failed', 'deleting')),
  on_device      boolean not null default false,
  error          text check (length(error) <= 200),
  inbox_path     text unique,
  device_file    text check (length(device_file) <= 500),        -- path on the speaker, under its music folder
  file_name      text check (length(file_name) <= 255),          -- the original file name
  art_path       text check (length(art_path) <= 200),
  plays          integer not null default 0,
  last_played_at timestamptz,
  sent_at        timestamptz,
  added_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (household_id, id),
  unique (device_id, sha256),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade
);
create index media_track_household_idx on public.media_track (household_id);
create index media_track_device_state_idx on public.media_track (device_id, state);
create index media_track_added_by_idx on public.media_track (added_by);

create table public.media_playlist (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 60),
  sort         integer not null default 0,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, id)
);
create index media_playlist_household_idx on public.media_playlist (household_id);
create index media_playlist_created_by_idx on public.media_playlist (created_by);

create table public.media_playlist_item (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  playlist_id  uuid not null,
  track_id     uuid not null,
  position     integer not null check (position >= 0),
  unique (playlist_id, track_id),
  foreign key (household_id, playlist_id) references public.media_playlist (household_id, id) on delete cascade,
  foreign key (household_id, track_id) references public.media_track (household_id, id) on delete cascade
);
create index media_playlist_item_order_idx on public.media_playlist_item (playlist_id, position);
create index media_playlist_item_track_idx on public.media_playlist_item (track_id);
create index media_playlist_item_household_idx on public.media_playlist_item (household_id);

-- Runs on the speaker itself at its time (Asia/Colombo), so it plays even with the internet down.
-- days: bit 0 = Monday … bit 6 = Sunday. No playlist = the whole library, shuffled.
create table public.media_schedule (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  device_id      uuid not null,
  name           text not null check (length(btrim(name)) between 1 and 40),
  days           smallint not null default 127 check (days between 1 and 127),
  start_time     time not null,
  playlist_id    uuid,
  volume         integer not null default 35 check (volume between 0 and 100),
  stop_after_min integer check (stop_after_min between 1 and 240),
  fade_s         integer not null default 30 check (fade_s between 0 and 120),
  shuffle        boolean not null default false,
  enabled        boolean not null default true,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade,
  foreign key (household_id, playlist_id) references public.media_playlist (household_id, id) on delete set null (playlist_id)
);
create index media_schedule_household_idx on public.media_schedule (household_id);
create index media_schedule_device_idx on public.media_schedule (device_id);
create index media_schedule_playlist_idx on public.media_schedule (playlist_id);
create index media_schedule_created_by_idx on public.media_schedule (created_by);

-- Inbox objects to delete from Storage (the function does it; SQL can't remove Storage files).
create table public.media_inbox_trash (
  path         text primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index media_inbox_trash_household_idx on public.media_inbox_trash (household_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.media_track enable row level security;
alter table public.media_playlist enable row level security;
alter table public.media_playlist_item enable row level security;
alter table public.media_schedule enable row level security;
alter table public.media_inbox_trash enable row level security;

revoke all on table public.media_track, public.media_playlist, public.media_playlist_item,
                    public.media_schedule, public.media_inbox_trash from anon, authenticated;
-- Songs and playlist order change only through the RPCs below; playlists and schedules directly.
grant select on table public.media_track, public.media_playlist_item to authenticated;
grant select, insert, update, delete on table public.media_playlist, public.media_schedule to authenticated;
-- media_inbox_trash: no grants.

create policy media_track_select on public.media_track
  for select to authenticated using (private.is_member(household_id));
create policy media_playlist_item_select on public.media_playlist_item
  for select to authenticated using (private.is_member(household_id));

create policy media_playlist_select on public.media_playlist
  for select to authenticated using (private.is_member(household_id));
create policy media_playlist_insert on public.media_playlist
  for insert to authenticated with check (private.can_write(household_id));
create policy media_playlist_update on public.media_playlist
  for update to authenticated using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy media_playlist_delete on public.media_playlist
  for delete to authenticated using (private.can_write(household_id));

create policy media_schedule_select on public.media_schedule
  for select to authenticated using (private.is_member(household_id));
create policy media_schedule_insert on public.media_schedule
  for insert to authenticated with check (private.can_write(household_id));
create policy media_schedule_update on public.media_schedule
  for update to authenticated using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy media_schedule_delete on public.media_schedule
  for delete to authenticated using (private.can_write(household_id));

-- A schedule belongs to a speaker (not a scale) of its own household.
create function private.media_schedule_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.device d where d.id = new.device_id and d.household_id = new.household_id
                   and d.kind = 'media' and d.revoked_at is null) then
    raise exception 'not a speaker of this household' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger media_schedule_check before insert or update on public.media_schedule
  for each row execute function private.media_schedule_check();

create trigger media_playlist_updated_at before update on public.media_playlist
  for each row execute function private.set_updated_at();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.media_track;
  end if;
end;
$$;

-- ── Storage ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-inbox', 'media-inbox', false, 62914560,
        array['audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/ogg', 'audio/wav']),
       ('media-art', 'media-art', false, 307200, array['image/webp'])
on conflict (id) do nothing;

-- An upload is accepted only at the path rpc_media_upload_begin handed out, while it's uploading.
create policy media_inbox_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media-inbox'
              and exists (select 1 from public.media_track t
                           where t.inbox_path = objects.name and t.state = 'uploading'
                             and private.can_write(t.household_id)));
create policy media_inbox_select on storage.objects
  for select to authenticated
  using (bucket_id = 'media-inbox'
         and private.is_member(public.safe_uuid((storage.foldername(name))[1])));

create policy media_art_select on storage.objects
  for select to authenticated
  using (bucket_id = 'media-art'
         and private.is_member(public.safe_uuid((storage.foldername(name))[1])));
create policy media_art_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media-art'
              and private.can_write(public.safe_uuid((storage.foldername(name))[1])));
create policy media_art_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'media-art'
         and private.can_write(public.safe_uuid((storage.foldername(name))[1])));

-- ── Upload RPCs ───────────────────────────────────────────────────────────────
create function private.media_device(p_device uuid)
returns public.device
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
begin
  select * into v_dev from public.device d where d.id = p_device;
  if not found or not private.can_write(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_dev.kind <> 'media' or v_dev.revoked_at is not null then
    raise exception 'not an active speaker' using errcode = '23514';
  end if;
  return v_dev;
end;
$$;
revoke execute on function private.media_device(uuid) from public, anon, authenticated;

-- p: { title, artist?, album?, track_no?, duration_s?, size_bytes, sha256, mime, file_name?, art_path? }
-- → { status: 'new', id, inbox_path } · { status: 'duplicate', id, state } (already on the speaker)
create function public.rpc_media_upload_begin(p_device uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev     public.device%rowtype := private.media_device(p_device);
  v_old     public.media_track%rowtype;
  v_id      uuid := gen_random_uuid();
  v_size    bigint := (p ->> 'size_bytes')::bigint;
  v_sha     text := lower(p ->> 'sha256');
  v_art     text := nullif(p ->> 'art_path', '');
  v_waiting bigint;
  v_retry   boolean := false;
begin
  if v_size is null or v_size < 1 or v_size > 62914560 then
    raise exception 'a song can be at most 60 MB' using errcode = '23514';
  end if;
  if v_art is not null and (v_art not like v_dev.household_id::text || '/%' or v_art like '%..%') then
    raise exception 'bad cover path' using errcode = '23514';
  end if;
  select * into v_old from public.media_track t where t.device_id = p_device and t.sha256 = v_sha for update;
  if found then
    if v_old.state <> 'failed' then
      return jsonb_build_object('status', 'duplicate', 'id', v_old.id, 'state', v_old.state);
    end if;
    v_retry := true;
  end if;
  select coalesce(sum(t.size_bytes), 0) into v_waiting from public.media_track t
   where t.household_id = v_dev.household_id and t.state in ('uploading', 'waiting', 'downloading');
  if v_waiting + v_size > 314572800 then
    raise exception 'the speaker is still collecting earlier songs' using errcode = 'GDMQF';
  end if;
  if v_retry then   -- a failed try of the same file: start it again
    v_id := v_old.id;
    if v_old.inbox_path is not null then
      insert into public.media_inbox_trash (path, household_id) values (v_old.inbox_path, v_old.household_id)
      on conflict do nothing;
    end if;
    update public.media_track t set
      title = btrim(p ->> 'title'), artist = nullif(btrim(p ->> 'artist'), ''), album = nullif(btrim(p ->> 'album'), ''),
      track_no = (p ->> 'track_no')::integer, duration_s = (p ->> 'duration_s')::numeric, size_bytes = v_size,
      mime = p ->> 'mime', file_name = left(p ->> 'file_name', 255), art_path = v_art,
      state = 'uploading', error = null, sent_at = null,
      inbox_path = v_dev.household_id::text || '/' || v_id::text || '-' || extract(epoch from now())::bigint::text,
      updated_at = now()
     where t.id = v_id;
  else
    insert into public.media_track (id, household_id, device_id, title, artist, album, track_no, duration_s,
                                    size_bytes, sha256, mime, source, state, inbox_path, file_name, art_path)
    values (v_id, v_dev.household_id, p_device, btrim(p ->> 'title'), nullif(btrim(p ->> 'artist'), ''),
            nullif(btrim(p ->> 'album'), ''), (p ->> 'track_no')::integer, (p ->> 'duration_s')::numeric,
            v_size, v_sha, p ->> 'mime', 'upload', 'uploading', v_dev.household_id::text || '/' || v_id::text,
            left(p ->> 'file_name', 255), v_art);
  end if;
  return jsonb_build_object('status', 'new', 'id', v_id,
                            'inbox_path', (select t.inbox_path from public.media_track t where t.id = v_id));
end;
$$;

-- The browser finished sending: the object must be there with the size it measured.
create function public.rpc_media_upload_done(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t    public.media_track%rowtype;
  v_size bigint;
begin
  select * into v_t from public.media_track t where t.id = p_id for update;
  if not found or not private.can_write(v_t.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_t.state <> 'uploading' then
    return jsonb_build_object('state', v_t.state);
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o
   where o.bucket_id = 'media-inbox' and o.name = v_t.inbox_path;
  if v_size is null or v_size <> v_t.size_bytes then
    raise exception 'the upload is not complete' using errcode = '23514';
  end if;
  update public.media_track t set state = 'waiting', updated_at = now() where t.id = p_id;
  return jsonb_build_object('state', 'waiting');
end;
$$;

-- Cancelled while uploading: forget it.
create function public.rpc_media_upload_abort(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.media_track%rowtype;
begin
  select * into v_t from public.media_track t where t.id = p_id for update;
  if not found or not private.can_write(v_t.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_t.state not in ('uploading', 'failed') then
    raise exception 'already sent' using errcode = '23514';
  end if;
  if v_t.inbox_path is not null then
    insert into public.media_inbox_trash (path, household_id) values (v_t.inbox_path, v_t.household_id)
    on conflict do nothing;
  end if;
  delete from public.media_track t where t.id = p_id;
end;
$$;

-- p: { title?, artist?, album?, track_no?, art_path? }
create function public.rpc_media_track_update(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t   public.media_track%rowtype;
  v_art text := nullif(p ->> 'art_path', '');
begin
  select * into v_t from public.media_track t where t.id = p_id for update;
  if not found or not private.can_write(v_t.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_art is not null and (v_art not like v_t.household_id::text || '/%' or v_art like '%..%') then
    raise exception 'bad cover path' using errcode = '23514';
  end if;
  update public.media_track t set
    title = case when p ? 'title' then btrim(p ->> 'title') else t.title end,
    artist = case when p ? 'artist' then nullif(btrim(p ->> 'artist'), '') else t.artist end,
    album = case when p ? 'album' then nullif(btrim(p ->> 'album'), '') else t.album end,
    track_no = case when p ? 'track_no' then (p ->> 'track_no')::integer else t.track_no end,
    art_path = case when p ? 'art_path' then v_art else t.art_path end,
    updated_at = now()
   where t.id = p_id;
end;
$$;

-- On the speaker → 'deleting' (it removes the file, then the row goes); not there yet → gone now.
create function public.rpc_media_track_delete(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.media_track%rowtype;
  v_n integer := 0;
begin
  if coalesce(cardinality(p_ids), 0) > 500 then
    raise exception 'at most 500 at a time' using errcode = '23514';
  end if;
  for v_t in select * from public.media_track t where t.id = any (p_ids) for update loop
    if not private.can_write(v_t.household_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_t.inbox_path is not null then
      insert into public.media_inbox_trash (path, household_id) values (v_t.inbox_path, v_t.household_id)
      on conflict do nothing;
    end if;
    if v_t.on_device then
      update public.media_track t set state = 'deleting', inbox_path = null, updated_at = now() where t.id = v_t.id;
      delete from public.media_playlist_item i where i.track_id = v_t.id;
    else
      delete from public.media_track t where t.id = v_t.id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Replaces a playlist's songs in this order (drag to reorder sends the whole list).
create function public.rpc_media_playlist_set(p_playlist uuid, p_track_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_n integer;
begin
  select pl.household_id into v_household from public.media_playlist pl where pl.id = p_playlist for update;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_track_ids), 0) > 1000 then
    raise exception 'at most 1000 songs in a playlist' using errcode = '23514';
  end if;
  delete from public.media_playlist_item i where i.playlist_id = p_playlist;
  insert into public.media_playlist_item (household_id, playlist_id, track_id, position)
  select v_household, p_playlist, x.id, (row_number() over (order by x.first) - 1)::integer
    from (select u.id, min(u.ord) as first from unnest(p_track_ids) with ordinality as u (id, ord) group by u.id) x
    join public.media_track t on t.id = x.id and t.household_id = v_household and t.state <> 'deleting';
  get diagnostics v_n = row_count;
  update public.media_playlist pl set updated_at = now() where pl.id = p_playlist;
  return v_n;
end;
$$;

revoke execute on function public.rpc_media_upload_begin(uuid, jsonb), public.rpc_media_upload_done(uuid),
  public.rpc_media_upload_abort(uuid), public.rpc_media_track_update(uuid, jsonb),
  public.rpc_media_track_delete(uuid[]), public.rpc_media_playlist_set(uuid, uuid[]) from public, anon;
grant execute on function public.rpc_media_upload_begin(uuid, jsonb), public.rpc_media_upload_done(uuid),
  public.rpc_media_upload_abort(uuid), public.rpc_media_track_update(uuid, jsonb),
  public.rpc_media_track_delete(uuid[]), public.rpc_media_playlist_set(uuid, uuid[]) to authenticated;

update public.app_meta set value = '71' where key = 'schema_version';
