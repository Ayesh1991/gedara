-- Phase 8b · 96 — the house log, sensors, and door/window alerts on the phone.
--
-- * home_entity gains three read-only kinds the bridge now reports from ESPHome devices only (the
--   cameras' motion sensors are never reported): presence (motion / occupancy / presence), binary
--   (dark detection, gas, moisture …) and sensor (temperature, humidity … with a unit). Each entity
--   also says where it comes from (platform), whether it is logged and whether it alerts.
-- * home_event: every change of a logged entity with Home Assistant's own time (the bridge batches
--   them, the time is never lost). A year of doors, windows and presence; 90 days of sensor values.
-- * home_alert_pref: each person's own choice (doors & windows off / always / at night; people
--   detected off / at night / always). home_alert_sent: what went to whom, which is also the
--   throttle (one per opening, openings within 2 minutes grouped; presence every 10 minutes).
-- rpc_home_sync stores the events and returns the alerts to send; the home-agent function sends
-- them with Web Push (the same keys as the morning summary) and never passes them on to the Pi.

-- ── home_entity: new kinds and flags ──────────────────────────────────────────
alter table public.home_entity drop constraint home_entity_domain_check;
alter table public.home_entity drop constraint home_entity_kind_check;
alter table public.home_entity drop constraint home_entity_check;
alter table public.home_entity drop constraint home_entity_check1;
alter table public.home_entity add constraint home_entity_domain_check
  check (domain in ('binary_sensor', 'light', 'switch', 'climate', 'sensor'));
alter table public.home_entity add constraint home_entity_kind_check
  check (kind in ('door', 'window', 'light', 'switch', 'climate', 'presence', 'binary', 'sensor'));
alter table public.home_entity add constraint home_entity_kind_domain_check check (
  case domain
    when 'binary_sensor' then kind in ('door', 'window', 'presence', 'binary')
    when 'sensor' then kind = 'sensor'
    else kind = domain
  end);
alter table public.home_entity add column platform text check (length(platform) <= 40);
alter table public.home_entity add column unit text check (length(unit) <= 12);
alter table public.home_entity add column logged boolean not null default false;
alter table public.home_entity add column alert boolean not null default false;
alter table public.home_entity add constraint home_entity_alert_check
  check (not alert or kind in ('door', 'window', 'presence'));
update public.home_entity set logged = kind in ('door', 'window'), alert = kind in ('door', 'window');

-- ── The log ───────────────────────────────────────────────────────────────────
create table public.home_event (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  entity       uuid,                                          -- null once the entity is gone from HA
  entity_id    text not null check (length(entity_id) <= 160),
  name         text not null check (length(name) <= 100),     -- as it was called then
  area         text check (length(area) <= 60),
  kind         text not null check (kind in ('door', 'window', 'light', 'switch', 'climate', 'presence', 'binary', 'sensor')),
  state        text not null check (length(state) <= 30),
  value        numeric(14,4),                                 -- sensors: the number
  unit         text check (length(unit) <= 12),
  at           timestamptz not null,                          -- Home Assistant's time of the change
  received_at  timestamptz not null default now(),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade,
  foreign key (household_id, entity) references public.home_entity (household_id, id) on delete set null (entity)
);
create index home_event_household_at_idx on public.home_event (household_id, at desc);
create unique index home_event_once_idx on public.home_event (device_id, entity_id, at);
create index home_event_entity_idx on public.home_event (household_id, entity);

-- ── Alerts: each person's choice, and what was sent ───────────────────────────
create table public.home_alert_pref (
  household_id uuid not null references public.household (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  doors        text not null default 'off' check (doors in ('off', 'always', 'night')),
  presence     text not null default 'off' check (presence in ('off', 'always', 'night')),
  night_from   time not null default '22:00',
  night_to     time not null default '06:00',
  updated_at   timestamptz not null default now(),
  primary key (household_id, user_id),
  foreign key (household_id, user_id) references public.household_member (household_id, user_id) on delete cascade
);
create index home_alert_pref_user_idx on public.home_alert_pref (user_id);

create table public.home_alert_sent (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  entity       uuid,
  event_id     bigint references public.home_event (id) on delete set null,
  title        text not null check (length(title) <= 120),
  body         text not null check (length(body) <= 200),
  devices      integer not null default 0,                    -- phones / browsers it went to
  created_at   timestamptz not null default now(),
  foreign key (household_id, entity) references public.home_entity (household_id, id) on delete set null (entity)
);
create index home_alert_sent_recent_idx on public.home_alert_sent (user_id, entity, created_at desc);
create index home_alert_sent_household_idx on public.home_alert_sent (household_id, created_at desc);
create index home_alert_sent_event_idx on public.home_alert_sent (event_id);

alter table public.home_event enable row level security;
alter table public.home_alert_pref enable row level security;
alter table public.home_alert_sent enable row level security;
revoke all on table public.home_event, public.home_alert_pref, public.home_alert_sent from anon, authenticated;
grant select on table public.home_event, public.home_alert_pref, public.home_alert_sent to authenticated;
create policy home_event_select on public.home_event
  for select to authenticated using (private.is_member(household_id));
create policy home_alert_pref_select on public.home_alert_pref
  for select to authenticated using (user_id = (select auth.uid()) and private.is_member(household_id));
create policy home_alert_sent_select on public.home_alert_sent
  for select to authenticated using (user_id = (select auth.uid()) and private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.home_event;
  end if;
end;
$$;

-- Is this local time inside the person's night (which may run past midnight)?
create function private.home_is_night(p_at timestamptz, p_tz text, p_from time, p_to time)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_from <= p_to then t >= p_from and t < p_to else t >= p_from or t < p_to end
    from (select (p_at at time zone coalesce(p_tz, 'Asia/Colombo'))::time as t) x
$$;
revoke execute on function private.home_is_night(timestamptz, text, time, time) from public, anon, authenticated;

-- ── The bridge's conversation (replaces migration 76's) ───────────────────────
-- p adds: catalog items { platform?, unit? }, events?: [{ entity_id, state, at }] ≤ 400.
-- → { device_id, name, commands, need_catalog, alerts: [{ endpoint, p256dh, auth, subscription_id,
--     title, body, tag, url }] } — alerts are for the home-agent function only (it strips them).
create or replace function public.rpc_home_sync(p_token_hash text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev    public.device%rowtype := private.home_device_by_token(p_token_hash, true);
  v_tz     text;
  v_e      jsonb;
  v_ids    text[];
  v_alerts jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p) <> 'object'
     or jsonb_array_length(coalesce(p -> 'catalog', '[]')) > 400 or jsonb_array_length(coalesce(p -> 'states', '[]')) > 400
     or jsonb_array_length(coalesce(p -> 'events', '[]')) > 400 or jsonb_array_length(coalesce(p -> 'done', '[]')) > 50 then
    raise exception 'too many items in one sync' using errcode = '23514';
  end if;
  select h.timezone into v_tz from public.household h where h.id = v_dev.household_id;

  update public.device d set
    last_seen_at = now(),
    fw_version = left(p ->> 'agent', 32),
    status = coalesce(p -> 'status', '{}'::jsonb) || jsonb_build_object('up', (p ->> 'up')::bigint)
   where d.id = v_dev.id;

  for v_e in select value from jsonb_array_elements(coalesce(p -> 'done', '[]')) loop
    update public.home_command c set
      status = case when (v_e ->> 'ok')::boolean then 'done' else 'failed' end,
      error = left(v_e ->> 'error', 200), done_at = now()
     where c.id = (v_e ->> 'id')::uuid and c.device_id = v_dev.id and c.status = 'sent';
  end loop;

  -- New entities get the defaults: doors, windows, lights, the AC and the sensors shown; the AC
  -- controllable; switches hidden until picked; doors, windows, presence and sensors logged;
  -- doors and windows alert. The owner's choices are kept.
  if p ? 'catalog' then
    for v_e in select value from jsonb_array_elements(p -> 'catalog') loop
      insert into public.home_entity as h (household_id, device_id, entity_id, domain, kind, ha_name, area, device_class,
                                           platform, unit, shown, controllable, logged, alert)
      values (v_dev.household_id, v_dev.id, v_e ->> 'entity_id', v_e ->> 'domain', v_e ->> 'kind',
              left(btrim(v_e ->> 'name'), 100), nullif(left(btrim(coalesce(v_e ->> 'area', '')), 60), ''),
              left(v_e ->> 'device_class', 30), left(v_e ->> 'platform', 40), left(v_e ->> 'unit', 12),
              (v_e ->> 'kind') <> 'switch', (v_e ->> 'kind') = 'climate',
              (v_e ->> 'kind') in ('door', 'window', 'presence', 'binary', 'sensor'), (v_e ->> 'kind') in ('door', 'window'))
      on conflict (device_id, entity_id) do update set
        domain = excluded.domain, kind = excluded.kind, ha_name = excluded.ha_name, area = excluded.area,
        device_class = excluded.device_class, platform = excluded.platform, unit = excluded.unit,
        controllable = h.controllable and excluded.kind in ('light', 'switch', 'climate'),
        alert = h.alert and excluded.kind in ('door', 'window', 'presence'),
        updated_at = now();
    end loop;
    if (p ->> 'catalog_full')::boolean then
      select coalesce(array_agg(value ->> 'entity_id'), '{}') into v_ids from jsonb_array_elements(p -> 'catalog');
      delete from public.home_entity h where h.device_id = v_dev.id and not (h.entity_id = any (v_ids));
    end if;
  end if;

  for v_e in select value from jsonb_array_elements(coalesce(p -> 'states', '[]')) loop
    update public.home_entity h set
      state = left(v_e ->> 'state', 30),
      attrs = case when h.kind = 'climate' then private.home_attrs(v_e -> 'attrs') else '{}'::jsonb end,
      changed_at = least(coalesce((v_e ->> 'changed_at')::timestamptz, now()), now()),
      updated_at = now()
     where h.device_id = v_dev.id and h.entity_id = v_e ->> 'entity_id';
  end loop;

  -- The log: changes of logged entities (from the last 2 days; each once), then the alerts for
  -- fresh openings / people detected, by each person's choice, at most one per opening (2 min)
  -- and one per presence sensor every 10 minutes.
  if p ? 'events' then
    with ev as (
      select e.value ->> 'entity_id' as entity_id, left(e.value ->> 'state', 30) as state,
             least((e.value ->> 'at')::timestamptz, now()) as at
        from jsonb_array_elements(p -> 'events') e
    ), ins as (
      insert into public.home_event as x (household_id, device_id, entity, entity_id, name, area, kind, state, value, unit, at)
      select v_dev.household_id, v_dev.id, h.id, h.entity_id, coalesce(h.label, h.ha_name), h.area, h.kind, ev.state,
             case when h.kind = 'sensor' and ev.state ~ '^-?[0-9]{1,9}(\.[0-9]+)?$' then round(ev.state::numeric, 4) end,
             h.unit, ev.at
        from ev join public.home_entity h on h.device_id = v_dev.id and h.entity_id = ev.entity_id and h.logged
       where ev.at > now() - interval '2 days'
      on conflict (device_id, entity_id, at) do nothing
      returning x.id, x.entity, x.name, x.area, x.kind, x.state, x.at
    ), fresh as (
      select i.* from ins i join public.home_entity h on h.id = i.entity
       where h.alert and i.state = 'on' and i.at > now() - interval '10 minutes'
    ), who as (
      select f.*, a.user_id
        from fresh f join public.home_alert_pref a on a.household_id = v_dev.household_id
       where (case when f.kind = 'presence' then a.presence else a.doors end) = 'always'
          or ((case when f.kind = 'presence' then a.presence else a.doors end) = 'night'
              and private.home_is_night(f.at, v_tz, a.night_from, a.night_to))
    ), due as (
      select distinct on (w.user_id, w.entity) w.*
        from who w
       where not exists (select 1 from public.home_alert_sent s
                          where s.user_id = w.user_id and s.entity = w.entity
                            and s.created_at > now() - case when w.kind = 'presence' then interval '10 minutes' else interval '2 minutes' end)
       order by w.user_id, w.entity, w.at
    ), sent as (
      insert into public.home_alert_sent (household_id, user_id, entity, event_id, title, body, devices)
      select v_dev.household_id, d.user_id, d.entity, d.id,
             left(case d.kind when 'door' then '🚪 ' || d.name || ' opened'
                              when 'window' then '🪟 ' || d.name || ' opened'
                              else '🚶 Someone in ' || coalesce(d.area, d.name) end, 120),
             left(concat_ws(' · ', d.area, to_char(d.at at time zone coalesce(v_tz, 'Asia/Colombo'), 'HH24:MI')), 200),
             (select count(*) from public.push_subscription s where s.user_id = d.user_id and s.household_id = v_dev.household_id and s.enabled)
        from due d
      returning user_id, entity, title, body
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'subscription_id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
             'title', x.title, 'body', x.body, 'tag', 'gedara-house-' || x.entity, 'url', '/house')), '[]'::jsonb)
      into v_alerts
      from sent x join public.push_subscription s on s.user_id = x.user_id and s.household_id = v_dev.household_id and s.enabled;
  end if;

  return jsonb_build_object(
    'device_id', v_dev.id,
    'name', v_dev.name,
    'commands', public.rpc_home_pending(p_token_hash) -> 'commands',
    'need_catalog', not exists (select 1 from public.home_entity h where h.device_id = v_dev.id),
    'alerts', v_alerts);
end;
$$;

-- ── The owner's chooser gains Log and Alert ───────────────────────────────────
create or replace function public.rpc_home_entity_set(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e      public.home_entity%rowtype;
  v_shown  boolean;
  v_ctl    boolean;
  v_label  text;
  v_logged boolean;
  v_alert  boolean;
begin
  select * into v_e from public.home_entity h where h.id = p_id for update;
  if not found or not private.is_owner(v_e.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select count(*) from jsonb_object_keys(p) k where k not in ('shown', 'controllable', 'label', 'logged', 'alert')) > 0
     or (p ? 'shown' and jsonb_typeof(p -> 'shown') <> 'boolean')
     or (p ? 'controllable' and jsonb_typeof(p -> 'controllable') <> 'boolean')
     or (p ? 'logged' and jsonb_typeof(p -> 'logged') <> 'boolean')
     or (p ? 'alert' and jsonb_typeof(p -> 'alert') <> 'boolean')
     or (p ? 'label' and jsonb_typeof(p -> 'label') not in ('string', 'null')) then
    raise exception 'invalid change' using errcode = '23514';
  end if;
  v_shown := coalesce((p ->> 'shown')::boolean, v_e.shown);
  v_ctl := coalesce((p ->> 'controllable')::boolean, v_e.controllable);
  v_logged := coalesce((p ->> 'logged')::boolean, v_e.logged);
  v_alert := coalesce((p ->> 'alert')::boolean, v_e.alert);
  v_label := case when p ? 'label' then nullif(btrim(coalesce(p ->> 'label', '')), '') else v_e.label end;
  if v_ctl and v_e.kind not in ('light', 'switch', 'climate') then
    raise exception 'only lights, switches and the AC can be controlled' using errcode = '23514';
  end if;
  if v_alert and v_e.kind not in ('door', 'window', 'presence') then
    raise exception 'only doors, windows and people detected can alert' using errcode = '23514';
  end if;
  if p ? 'controllable' and v_ctl then v_shown := true; end if;
  if not v_shown then v_ctl := false; end if;
  if v_label is not null and length(v_label) > 40 then
    raise exception 'name must be 1–40 characters' using errcode = '23514';
  end if;
  update public.home_entity h set shown = v_shown, controllable = v_ctl, label = v_label, logged = v_logged,
         alert = v_alert, updated_at = now()
   where h.id = p_id
  returning * into v_e;
  return jsonb_build_object('id', v_e.id, 'shown', v_e.shown, 'controllable', v_e.controllable, 'label', v_e.label,
                            'logged', v_e.logged, 'alert', v_e.alert);
end;
$$;

-- ── Each person's own alerts ──────────────────────────────────────────────────
-- p { doors?: off|always|night, presence?: off|always|night, night_from?: 'HH:MM', night_to?: 'HH:MM' }
create function public.rpc_home_alert_pref_set(p_household uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.home_alert_pref%rowtype;
begin
  if p_household is null or not private.is_member(p_household) or auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select count(*) from jsonb_object_keys(p) k where k not in ('doors', 'presence', 'night_from', 'night_to')) > 0
     or (p ? 'doors' and coalesce(p ->> 'doors', '') not in ('off', 'always', 'night'))
     or (p ? 'presence' and coalesce(p ->> 'presence', '') not in ('off', 'always', 'night'))
     or (p ? 'night_from' and coalesce(p ->> 'night_from', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     or (p ? 'night_to' and coalesce(p ->> 'night_to', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'invalid choice' using errcode = '23514';
  end if;
  insert into public.home_alert_pref as a (household_id, user_id) values (p_household, auth.uid())
  on conflict (household_id, user_id) do nothing;
  update public.home_alert_pref a set
    doors = coalesce(p ->> 'doors', a.doors),
    presence = coalesce(p ->> 'presence', a.presence),
    night_from = coalesce((p ->> 'night_from')::time, a.night_from),
    night_to = coalesce((p ->> 'night_to')::time, a.night_to),
    updated_at = now()
   where a.household_id = p_household and a.user_id = auth.uid()
  returning * into v_row;
  return jsonb_build_object('doors', v_row.doors, 'presence', v_row.presence,
                            'night_from', to_char(v_row.night_from, 'HH24:MI'), 'night_to', to_char(v_row.night_to, 'HH24:MI'));
end;
$$;
revoke execute on function public.rpc_home_alert_pref_set(uuid, jsonb) from public, anon;
grant execute on function public.rpc_home_alert_pref_set(uuid, jsonb) to authenticated;

-- ── Housekeeping: a year of the log (90 days of sensor values), 90 days of alerts ────
alter function private.housekeeping() rename to housekeeping_v95;
revoke execute on function private.housekeeping_v95() from public, anon, authenticated;

create function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.housekeeping_v95();
  delete from public.home_event e where e.kind = 'sensor' and e.at < now() - interval '90 days';
  delete from public.home_event e where e.at < now() - interval '365 days';
  delete from public.home_alert_sent s where s.created_at < now() - interval '90 days';
end;
$$;
revoke execute on function private.housekeeping() from public, anon, authenticated;

update public.app_meta set value = '96' where key = 'schema_version';
