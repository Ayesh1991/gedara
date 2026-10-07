-- Phase 6b · 62 — kitchen-scale devices (MASTER_PLAN §7b, replaced 2026-10-03: ESP32-S3 + NFC)
-- A scale posts to the scale-ingest Edge Function with a per-device secret token. As for the SMS
-- phone (migration 18), the token is shown once when the device is added and only its sha256 is
-- kept, here in its own table `device_token` that clients can't touch at all, so every column of
-- `device` can be read (and sent over Realtime for the live card) without leaking the hash.
-- Adding or revoking a device is owner-only; members may rename it, change its sound settings and
-- watch it (calibration wizard).

create table public.device (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.household (id) on delete cascade,
  kind             text not null default 'scale' check (kind in ('scale')),
  name             text not null check (length(btrim(name)) between 1 and 40),
  token_hint       text not null check (length(token_hint) = 4),      -- last 4 characters of the token
  -- Sound + weighing settings the device downloads (settings_version tells it something changed).
  settings         jsonb not null default
                     '{"volume": 60, "quiet_from": "22:00", "quiet_to": "06:00", "voice": true, "threshold_g": 2}'
                     check (jsonb_typeof(settings) = 'object'),
  settings_version integer not null default 1,
  calibrated_at    timestamptz,
  -- Reported by the device on every sync.
  last_seen_at     timestamptz,
  fw_version       text check (length(fw_version) <= 32),
  epoch            bigint check (epoch between 0 and 4294967295),    -- random id of the device's flash
  seq_floor        bigint not null default 0,                         -- readings up to here were pruned
  status           jsonb check (status is null or jsonb_typeof(status) = 'object'),
  -- Live state for the Kitchen-scale page (best effort, never queued on the device).
  live_state       text check (live_state in ('empty', 'settling', 'stable', 'overload', 'no_tag', 'setup', 'error')),
  live_uid         text check (length(live_uid) <= 20),
  live_gross_g     numeric(14,4),
  live_at          timestamptz,
  watch_until      timestamptz,                                       -- someone is watching: poll every second
  reading_count    integer not null default 0,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  unique (household_id, id)
);

create index device_household_idx on public.device (household_id);
create index device_created_by_idx on public.device (created_by);

create table public.device_token (
  device_id    uuid primary key references public.device (id) on delete cascade,
  household_id uuid not null references public.household (id) on delete cascade,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$')
);

create index device_token_household_idx on public.device_token (household_id);

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.device enable row level security;
alter table public.device_token enable row level security;

revoke all on table public.device from anon, authenticated;
revoke all on table public.device_token from anon, authenticated;
grant select on table public.device to authenticated;
-- device_token: no grants and no policies — only SECURITY DEFINER functions read it.

create policy device_select on public.device
  for select to authenticated
  using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.device;
  end if;
end;
$$;

-- ── Settings check (shared by create/update) ──────────────────────────────────
create function private.device_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k not in ('volume', 'quiet_from', 'quiet_to', 'voice', 'threshold_g')) = 0
     and (not p ? 'volume' or (jsonb_typeof(p -> 'volume') = 'number'
                               and (p ->> 'volume')::numeric between 0 and 100
                               and (p ->> 'volume')::numeric = trunc((p ->> 'volume')::numeric)))
     and (not p ? 'quiet_from' or coalesce(p ->> 'quiet_from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'quiet_to' or coalesce(p ->> 'quiet_to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'voice' or jsonb_typeof(p -> 'voice') = 'boolean')
     and (not p ? 'threshold_g' or (jsonb_typeof(p -> 'threshold_g') = 'number'
                                    and (p ->> 'threshold_g')::numeric between 1 and 20))
$$;

revoke execute on function private.device_settings_valid(jsonb) from public, anon, authenticated;

-- ── rpc_device_create: returns the plain token exactly once ──────────────────
create function public.rpc_device_create(p_household uuid, p_name text, p_kind text default 'scale')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_id    uuid;
begin
  if p_household is null or not private.is_owner(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(p_kind, '') <> 'scale' then
    raise exception 'unknown device kind' using errcode = '23514';
  end if;
  if (select count(*) from public.device d
       where d.household_id = p_household and d.kind = p_kind and d.revoked_at is null) >= 3 then
    raise exception 'at most 3 active scales' using errcode = '23514';
  end if;
  -- 32 random bytes, base64url without padding (43 characters) — same shape as the SMS phone token.
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.device (household_id, kind, name, token_hint)
  values (p_household, p_kind, btrim(p_name), right(v_token, 4))
  returning id into v_id;
  insert into public.device_token (device_id, household_id, token_hash)
  values (v_id, p_household, encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'));
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;

-- Revoking also forgets the token hash: a revoked device can never sign in again.
create function public.rpc_device_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select d.household_id into v_household from public.device d where d.id = p_id;
  if v_household is null or not private.is_owner(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.device d set revoked_at = coalesce(d.revoked_at, now()), live_state = null, watch_until = null
   where d.id = p_id;
  delete from public.device_token t where t.device_id = p_id;
end;
$$;

-- p: { name?, settings? (merged into the current settings) }
create function public.rpc_device_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
  v_settings jsonb;
begin
  select * into v_dev from public.device d where d.id = p_id for update;
  if not found or not private.can_write(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_dev.revoked_at is not null then
    raise exception 'this device was removed' using errcode = '23514';
  end if;
  if p ? 'settings' then
    v_settings := v_dev.settings || coalesce(p -> 'settings', '{}'::jsonb);
    if not private.device_settings_valid(v_settings) then
      raise exception 'invalid settings' using errcode = '23514';
    end if;
  else
    v_settings := v_dev.settings;
  end if;
  update public.device d set
    name = case when p ? 'name' then btrim(p ->> 'name') else d.name end,
    settings = v_settings,
    settings_version = d.settings_version + case when v_settings is distinct from v_dev.settings then 1 else 0 end
   where d.id = p_id;
  return jsonb_build_object('settings', v_settings);
end;
$$;

-- "Someone is watching this scale" (calibration page): the device polls every second until then.
create function public.rpc_device_watch(p_id uuid, p_minutes integer default 10)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_until     timestamptz := now() + make_interval(mins => least(greatest(coalesce(p_minutes, 10), 0), 15));
begin
  select d.household_id into v_household from public.device d where d.id = p_id and d.revoked_at is null;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.device d set watch_until = case when p_minutes = 0 then null else v_until end where d.id = p_id;
  return case when p_minutes = 0 then null else v_until end;
end;
$$;

revoke execute on function public.rpc_device_create(uuid, text, text) from public, anon;
revoke execute on function public.rpc_device_revoke(uuid) from public, anon;
revoke execute on function public.rpc_device_update(uuid, jsonb) from public, anon;
revoke execute on function public.rpc_device_watch(uuid, integer) from public, anon;
grant execute on function public.rpc_device_create(uuid, text, text) to authenticated;
grant execute on function public.rpc_device_revoke(uuid) to authenticated;
grant execute on function public.rpc_device_update(uuid, jsonb) to authenticated;
grant execute on function public.rpc_device_watch(uuid, integer) to authenticated;

update public.app_meta set value = '62' where key = 'schema_version';
