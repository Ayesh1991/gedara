-- Phase 8 · 76 — what the Home Assistant bridge reports (home_entity, live over Realtime), the
-- commands Gedara sends it (home_command), and its one conversation with Gedara (rpc_home_sync,
-- service role only, called by the home-agent Edge Function with the bridge's key hash).
--
-- Only five kinds of thing come here: doors and windows (HA binary_sensors), lights, switches and
-- climate (the AC). The bridge itself refuses every Home Assistant service except switch/light
-- on-off and the four climate ones, whatever Gedara asks (devices/home-bridge); here the owner
-- chooses what is shown and what may be controlled, and only owner + members (private.can_write)
-- may send a command, only to a controllable entity, with arguments checked against the entity.
-- A command not picked up within 60 s expires; commands are kept 30 days as the history.

create table public.home_entity (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  entity_id    text not null check (entity_id ~ '^[a-z_]{1,30}\.[a-z0-9_]{1,120}$'),
  domain       text not null check (domain in ('binary_sensor', 'light', 'switch', 'climate')),
  kind         text not null check (kind in ('door', 'window', 'light', 'switch', 'climate')),
  ha_name      text not null check (length(ha_name) between 1 and 100),
  label        text check (length(btrim(label)) between 1 and 40),   -- the owner's short name
  area         text check (length(area) between 1 and 60),           -- the HA area (room)
  device_class text check (length(device_class) <= 30),
  state        text check (length(state) <= 30),                     -- HA's state: on/off, cool/off, unavailable …
  attrs        jsonb not null default '{}' check (jsonb_typeof(attrs) = 'object' and pg_column_size(attrs) <= 2000),
  shown        boolean not null default true,
  controllable boolean not null default false,
  changed_at   timestamptz,                                          -- when HA says the state last changed
  updated_at   timestamptz not null default now(),
  unique (device_id, entity_id),
  unique (household_id, id),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade,
  check ((domain = 'binary_sensor') = (kind in ('door', 'window'))),
  check (domain = 'binary_sensor' or domain = kind),
  check (not controllable or (kind in ('light', 'switch', 'climate') and shown))
);
create index home_entity_household_idx on public.home_entity (household_id);

create table public.home_command (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  entity       uuid not null,
  entity_id    text not null check (length(entity_id) <= 160),
  action       text not null check (action in ('turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode')),
  args         jsonb not null default '{}' check (jsonb_typeof(args) = 'object'),
  status       text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'expired')),
  error        text check (length(error) <= 200),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz,
  unique (household_id, id),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade,
  foreign key (household_id, entity) references public.home_entity (household_id, id) on delete cascade
);
create index home_command_open_idx on public.home_command (device_id, created_at) where status = 'queued';
create index home_command_household_idx on public.home_command (household_id, created_at desc);
create index home_command_device_idx on public.home_command (device_id);
create index home_command_entity_idx on public.home_command (household_id, entity);
create index home_command_created_by_idx on public.home_command (created_by);

alter table public.home_entity enable row level security;
alter table public.home_command enable row level security;
revoke all on table public.home_entity, public.home_command from anon, authenticated;
grant select on table public.home_entity, public.home_command to authenticated;
create policy home_entity_select on public.home_entity
  for select to authenticated using (private.is_member(household_id));
create policy home_command_select on public.home_command
  for select to authenticated using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.home_entity;
    alter publication supabase_realtime add table public.home_command;
  end if;
end;
$$;

-- ── Helpers ───────────────────────────────────────────────────────────────────
-- The bridge by its key. p_lock: FOR UPDATE (one sync at a time per bridge); the wait must not lock.
create function private.home_device_by_token(p_token_hash text, p_lock boolean default false)
returns public.device
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
begin
  if p_lock then
    select d.* into v_dev from public.home_token t join public.device d on d.id = t.device_id
     where t.token_hash = p_token_hash and d.revoked_at is null and d.kind = 'home'
     for update of d;
  else
    select d.* into v_dev from public.home_token t join public.device d on d.id = t.device_id
     where t.token_hash = p_token_hash and d.revoked_at is null and d.kind = 'home';
  end if;
  if v_dev.id is null then
    raise exception 'unknown or removed bridge' using errcode = '42501';
  end if;
  return v_dev;
end;
$$;
revoke execute on function private.home_device_by_token(text, boolean) from public, anon, authenticated;

-- Only the climate attributes Gedara shows, with their types checked; everything else HA sends is dropped.
create function private.home_attrs(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) as e (k, v)
   -- CASE, not AND: SQL doesn't promise to test the type before the cast.
   where case
           when k in ('current_temperature', 'temperature', 'min_temp', 'max_temp', 'target_temp_step') then
             case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric between -50 and 100 else false end
           when k = 'hvac_modes' then
             case when jsonb_typeof(v) = 'array' then
               jsonb_array_length(v) <= 10
               and not exists (select 1 from jsonb_array_elements(v) m
                                where jsonb_typeof(m) <> 'string' or length(m #>> '{}') > 20)
             else false end
           else false
         end
$$;
revoke execute on function private.home_attrs(jsonb) from public, anon, authenticated;

-- ── The bridge's side (service role only) ─────────────────────────────────────
-- Queued commands for the bridge (marked sent), oldest first; older than 60 s expire instead.
create function public.rpc_home_pending(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev  public.device%rowtype := private.home_device_by_token(p_token_hash);
  v_cmds jsonb;
begin
  update public.home_command c set status = 'expired'
   where c.device_id = v_dev.id and c.status = 'queued' and c.created_at < now() - interval '60 seconds';
  with picked as (
    update public.home_command c set status = 'sent', sent_at = now()
     where c.device_id = v_dev.id and c.status = 'queued'
    returning c.id, c.entity_id, c.action, c.args, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'entity_id', entity_id, 'action', action, 'args', args)
                            order by created_at), '[]')
    into v_cmds from picked;
  return jsonb_build_object('commands', v_cmds);
end;
$$;

-- The long-poll's wait, inside Postgres (same as rpc_media_wait, migration 74): read-only, no
-- locks, every 0.3 s for at most 7 s; true as soon as a command is queued for this bridge.
create function public.rpc_home_wait(p_token_hash text, p_ms integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device uuid := (private.home_device_by_token(p_token_hash)).id;
  v_until  timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_ms, 0), 100), 7000) / 1000.0);
begin
  loop
    if exists (select 1 from public.home_command c where c.device_id = v_device and c.status = 'queued') then
      return true;
    end if;
    exit when clock_timestamp() >= v_until;
    perform pg_sleep(least(0.3, greatest(extract(epoch from v_until - clock_timestamp()), 0)));
  end loop;
  return false;
end;
$$;

-- p (Zod-checked by the function, supabase/functions/_shared/home/protocol.ts):
--   { agent, up, status?: { ha, ha_version?, entities? },
--     catalog?: [{ entity_id, domain, kind, name, area?, device_class? }] ≤ 400, catalog_full?: bool,
--     states?: [{ entity_id, state, attrs?, changed_at? }] ≤ 400, done?: [{ id, ok, error? }] ≤ 50 }
-- → { device_id, name, commands, need_catalog }
create function public.rpc_home_sync(p_token_hash text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev   public.device%rowtype := private.home_device_by_token(p_token_hash, true);
  v_e     jsonb;
  v_ids   text[];
begin
  if jsonb_typeof(p) <> 'object'
     or jsonb_array_length(coalesce(p -> 'catalog', '[]')) > 400 or jsonb_array_length(coalesce(p -> 'states', '[]')) > 400
     or jsonb_array_length(coalesce(p -> 'done', '[]')) > 50 then
    raise exception 'too many items in one sync' using errcode = '23514';
  end if;

  update public.device d set
    last_seen_at = now(),
    fw_version = left(p ->> 'agent', 32),
    status = coalesce(p -> 'status', '{}'::jsonb) || jsonb_build_object('up', (p ->> 'up')::bigint)
   where d.id = v_dev.id;

  -- Commands it carried out (or Home Assistant refused).
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'done', '[]')) loop
    update public.home_command c set
      status = case when (v_e ->> 'ok')::boolean then 'done' else 'failed' end,
      error = left(v_e ->> 'error', 200), done_at = now()
     where c.id = (v_e ->> 'id')::uuid and c.device_id = v_dev.id and c.status = 'sent';
  end loop;

  -- What Home Assistant has: new entities get the defaults (doors, windows, lights and the AC shown,
  -- the AC controllable, switches hidden until the owner picks them); the owner's choices are kept.
  if p ? 'catalog' then
    for v_e in select value from jsonb_array_elements(p -> 'catalog') loop
      insert into public.home_entity as h (household_id, device_id, entity_id, domain, kind, ha_name, area, device_class,
                                           shown, controllable)
      values (v_dev.household_id, v_dev.id, v_e ->> 'entity_id', v_e ->> 'domain', v_e ->> 'kind',
              left(btrim(v_e ->> 'name'), 100), nullif(left(btrim(coalesce(v_e ->> 'area', '')), 60), ''),
              left(v_e ->> 'device_class', 30),
              (v_e ->> 'kind') <> 'switch', (v_e ->> 'kind') = 'climate')
      on conflict (device_id, entity_id) do update set
        domain = excluded.domain, kind = excluded.kind, ha_name = excluded.ha_name, area = excluded.area,
        device_class = excluded.device_class,
        controllable = h.controllable and excluded.kind in ('light', 'switch', 'climate'),
        updated_at = now();
    end loop;
    if (p ->> 'catalog_full')::boolean then
      select coalesce(array_agg(value ->> 'entity_id'), '{}') into v_ids from jsonb_array_elements(p -> 'catalog');
      delete from public.home_entity h where h.device_id = v_dev.id and not (h.entity_id = any (v_ids));
    end if;
  end if;

  -- Live states (only of entities it already listed).
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'states', '[]')) loop
    update public.home_entity h set
      state = left(v_e ->> 'state', 30),
      attrs = case when h.kind = 'climate' then private.home_attrs(v_e -> 'attrs') else '{}'::jsonb end,
      changed_at = least(coalesce((v_e ->> 'changed_at')::timestamptz, now()), now()),
      updated_at = now()
     where h.device_id = v_dev.id and h.entity_id = v_e ->> 'entity_id';
  end loop;

  return jsonb_build_object(
    'device_id', v_dev.id,
    'name', v_dev.name,
    'commands', public.rpc_home_pending(p_token_hash) -> 'commands',
    'need_catalog', not exists (select 1 from public.home_entity h where h.device_id = v_dev.id));
end;
$$;

revoke execute on function public.rpc_home_pending(text), public.rpc_home_wait(text, integer),
  public.rpc_home_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_home_pending(text), public.rpc_home_wait(text, integer),
  public.rpc_home_sync(text, jsonb) to service_role;

-- ── Gedara's side ─────────────────────────────────────────────────────────────
-- The owner chooses: p { shown?: bool, controllable?: bool, label?: text|null }. Controllable is only
-- for lights, switches and the AC, and implies shown; hiding something also stops its control.
create function public.rpc_home_entity_set(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e     public.home_entity%rowtype;
  v_shown boolean;
  v_ctl   boolean;
  v_label text;
begin
  select * into v_e from public.home_entity h where h.id = p_id for update;
  if not found or not private.is_owner(v_e.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select count(*) from jsonb_object_keys(p) k where k not in ('shown', 'controllable', 'label')) > 0
     or (p ? 'shown' and jsonb_typeof(p -> 'shown') <> 'boolean')
     or (p ? 'controllable' and jsonb_typeof(p -> 'controllable') <> 'boolean')
     or (p ? 'label' and jsonb_typeof(p -> 'label') not in ('string', 'null')) then
    raise exception 'invalid change' using errcode = '23514';
  end if;
  v_shown := coalesce((p ->> 'shown')::boolean, v_e.shown);
  v_ctl := coalesce((p ->> 'controllable')::boolean, v_e.controllable);
  v_label := case when p ? 'label' then nullif(btrim(coalesce(p ->> 'label', '')), '') else v_e.label end;
  if v_ctl and v_e.kind not in ('light', 'switch', 'climate') then
    raise exception 'doors and windows can only be shown' using errcode = '23514';
  end if;
  if p ? 'controllable' and v_ctl then v_shown := true; end if;
  if not v_shown then v_ctl := false; end if;
  if v_label is not null and length(v_label) > 40 then
    raise exception 'name must be 1–40 characters' using errcode = '23514';
  end if;
  update public.home_entity h set shown = v_shown, controllable = v_ctl, label = v_label, updated_at = now()
   where h.id = p_id
  returning * into v_e;
  return jsonb_build_object('id', v_e.id, 'shown', v_e.shown, 'controllable', v_e.controllable, 'label', v_e.label);
end;
$$;

-- A command from Gedara (owner or member): turn_on / turn_off (lights, switches, AC),
-- set_temperature { temperature } and set_hvac_mode { hvac_mode } (AC). Returns the command's id.
-- At most 60 a minute per household (GDRTE). A second on/off for the same thing before the bridge
-- picked the first replaces it; so does a second temperature or mode.
create function public.rpc_home_command(p_entity uuid, p_action text, p_args jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e    public.home_entity%rowtype;
  v_dev  public.device%rowtype;
  v_a    jsonb := coalesce(p_args, '{}'::jsonb);
  v_out  jsonb := '{}'::jsonb;
  v_t    numeric;
  v_lo   numeric;
  v_hi   numeric;
  v_mode text;
  v_id   uuid;
begin
  select * into v_e from public.home_entity h where h.id = p_entity;
  if not found or not private.can_write(v_e.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_dev from public.device d where d.id = v_e.device_id;
  if v_dev.revoked_at is not null or v_dev.kind <> 'home' then
    raise exception 'the Home Assistant bridge was removed' using errcode = '23514';
  end if;
  if not v_e.controllable then
    raise exception 'not controllable from Gedara' using errcode = '42501';
  end if;
  if v_e.state is null or v_e.state in ('unavailable', 'unknown') then
    raise exception 'Home Assistant says it is unavailable' using errcode = '23514';
  end if;
  if jsonb_typeof(v_a) <> 'object' then
    raise exception 'args must be an object' using errcode = '23514';
  end if;
  if (select count(*) from public.home_command c
       where c.household_id = v_e.household_id and c.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'too many commands, wait a minute' using errcode = 'GDRTE';
  end if;

  if p_action in ('turn_on', 'turn_off') then
    null;
  elsif p_action = 'set_temperature' and v_e.kind = 'climate' then
    if jsonb_typeof(v_a -> 'temperature') <> 'number' then
      raise exception 'temperature must be a number' using errcode = '23514';
    end if;
    v_t := (v_a ->> 'temperature')::numeric;
    v_lo := coalesce((v_e.attrs ->> 'min_temp')::numeric, 16);
    v_hi := coalesce((v_e.attrs ->> 'max_temp')::numeric, 32);
    if v_t < v_lo or v_t > v_hi or v_t * 2 <> trunc(v_t * 2) then
      raise exception 'temperature must be % to % in half degrees', v_lo, v_hi using errcode = '23514';
    end if;
    v_out := jsonb_build_object('temperature', v_t);
  elsif p_action = 'set_hvac_mode' and v_e.kind = 'climate' then
    v_mode := v_a ->> 'hvac_mode';
    if v_mode is null or not (case when v_e.attrs ? 'hvac_modes' then (v_e.attrs -> 'hvac_modes') ? v_mode
                                   else v_mode in ('off', 'cool', 'heat', 'dry', 'fan_only', 'auto', 'heat_cool') end) then
      raise exception 'this AC has no mode %', coalesce(v_mode, '(none)') using errcode = '23514';
    end if;
    v_out := jsonb_build_object('hvac_mode', v_mode);
  else
    raise exception 'unknown command' using errcode = '23514';
  end if;

  update public.home_command c set status = 'expired'
   where c.entity = v_e.id and c.status = 'queued'
     and (c.action = p_action or (p_action in ('turn_on', 'turn_off') and c.action in ('turn_on', 'turn_off')));
  insert into public.home_command (household_id, device_id, entity, entity_id, action, args)
  values (v_e.household_id, v_e.device_id, v_e.id, v_e.entity_id, p_action, v_out)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.rpc_home_entity_set(uuid, jsonb), public.rpc_home_command(uuid, text, jsonb)
  from public, anon;
grant execute on function public.rpc_home_entity_set(uuid, jsonb), public.rpc_home_command(uuid, text, jsonb)
  to authenticated;

-- ── Housekeeping (migration 72's, plus the bridge's commands) ─────────────────
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

  -- Home Assistant bridge (Phase 8): 30 days of command history.
  delete from public.home_command c where c.created_at < now() - interval '30 days';
end;
$$;

update public.app_meta set value = '76' where key = 'schema_version';
