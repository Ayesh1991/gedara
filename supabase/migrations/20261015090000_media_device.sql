-- Phase 7h · 70 — the music speaker (Raspberry Pi 2, docs/media-player): a second kind of device,
-- paired with a 6-digit code instead of a key to copy.
--
-- Pairing: the Pi makes its own 43-character key and sends only its sha256 to the media-agent Edge
-- Function (pair_start), which stores it here with a short random code and shows the code on the PC
-- (install.ps1 -Music). The owner types the code in Settings › Devices (rpc_device_pair): that turns
-- the waiting pairing into a device whose key hash is the Pi's. The key itself is never stored and
-- never travels anywhere except from the Pi to the function, so there is nothing secret to copy.
--
-- Speaker keys live in their own table `media_token`, so the kitchen scale's rpc_scale_sync (which
-- looks keys up in `device_token`) can never be called with a speaker's key, and vice versa.

-- ── device.kind ───────────────────────────────────────────────────────────────
alter table public.device drop constraint device_kind_check;
alter table public.device add constraint device_kind_check check (kind in ('scale', 'media'));

-- ── Speaker keys (no grants, no policies: only SECURITY DEFINER functions read it) ─────────────
create table public.media_token (
  device_id    uuid primary key references public.device (id) on delete cascade,
  household_id uuid not null references public.household (id) on delete cascade,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$')
);
create index media_token_household_idx on public.media_token (household_id);
alter table public.media_token enable row level security;
revoke all on table public.media_token from anon, authenticated;

-- ── Waiting pairings (no grants) ──────────────────────────────────────────────
create table public.device_pairing (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'media' check (kind in ('media')),
  code       text not null check (code ~ '^[0-9]{6}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  hint       text not null check (length(hint) = 4),          -- last 4 characters of the Pi's key
  agent      text check (length(agent) <= 40),                -- what the Pi says it is ("gedara-media 0.1.0")
  source     text check (source ~ '^[0-9a-f]{64}$'),           -- sha256 of the caller's IP (rate limit only)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
create unique index device_pairing_code_idx on public.device_pairing (code);
create index device_pairing_source_idx on public.device_pairing (source);
alter table public.device_pairing enable row level security;
revoke all on table public.device_pairing from anon, authenticated;

-- Wrong codes typed (at most 10 tries in 10 minutes per household, 30 across everyone).
create table public.device_pair_attempt (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  at           timestamptz not null default now()
);
create index device_pair_attempt_household_idx on public.device_pair_attempt (household_id, at);
create index device_pair_attempt_at_idx on public.device_pair_attempt (at);
alter table public.device_pair_attempt enable row level security;
revoke all on table public.device_pair_attempt from anon, authenticated;

-- ── Settings per kind ─────────────────────────────────────────────────────────
-- Speaker: volume_max (the loudest anyone can set, 10–100), fade_s (sleep-timer fade, 0–60 s),
-- normalise (even out loud and quiet songs).
create function private.media_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k where k not in ('volume_max', 'fade_s', 'normalise')) = 0
     and (not p ? 'volume_max' or (jsonb_typeof(p -> 'volume_max') = 'number'
                                   and (p ->> 'volume_max')::numeric between 10 and 100
                                   and (p ->> 'volume_max')::numeric = trunc((p ->> 'volume_max')::numeric)))
     and (not p ? 'fade_s' or (jsonb_typeof(p -> 'fade_s') = 'number'
                               and (p ->> 'fade_s')::numeric between 0 and 60
                               and (p ->> 'fade_s')::numeric = trunc((p ->> 'fade_s')::numeric)))
     and (not p ? 'normalise' or jsonb_typeof(p -> 'normalise') = 'boolean')
$$;
revoke execute on function private.media_settings_valid(jsonb) from public, anon, authenticated;

-- Same as migration 62, with the settings checked for the device's own kind.
create or replace function public.rpc_device_update(p_id uuid, p jsonb)
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
    if not (case v_dev.kind when 'media' then private.media_settings_valid(v_settings)
                            else private.device_settings_valid(v_settings) end) then
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

-- Same as migration 62; also forgets a speaker's key.
create or replace function public.rpc_device_revoke(p_id uuid)
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
  delete from public.media_token t where t.device_id = p_id;
end;
$$;

-- ── Pairing, the Pi's side (service role only: called by the media-agent function) ────────────
-- Returns the waiting pairing's code (the same one again if the Pi asks twice), or GDRTE when one
-- caller (by the sha256 of its IP, from the function) already has 3 waiting, or 100 wait in all:
-- a loop calling the function can neither fill the table nor block other people's pairing.
create function public.rpc_media_pair_start(p_token_hash text, p_hint text, p_agent text default null,
                                            p_source text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.device_pairing%rowtype;
  v_code  text;
  v_bytes bytea;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' or length(coalesce(p_hint, '')) <> 4
     or coalesce(p_source, repeat('0', 64)) !~ '^[0-9a-f]{64}$' then
    raise exception 'bad pairing request' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('gedara.device_pairing'));
  if exists (select 1 from public.media_token t where t.token_hash = p_token_hash) then
    return jsonb_build_object('status', 'paired');
  end if;
  delete from public.device_pairing d where d.expires_at < now();
  select * into v_row from public.device_pairing d where d.token_hash = p_token_hash;
  if found then
    return jsonb_build_object('status', 'waiting', 'code', v_row.code, 'expires_at', v_row.expires_at);
  end if;
  if p_source is not null and (select count(*) from public.device_pairing d where d.source = p_source) >= 3 then
    raise exception 'too many pairings waiting from here' using errcode = 'GDRTE';
  end if;
  if (select count(*) from public.device_pairing) >= 100 then
    raise exception 'too many pairings waiting' using errcode = 'GDRTE';
  end if;
  loop
    v_bytes := extensions.gen_random_bytes(3);
    v_code := lpad(((get_byte(v_bytes, 0) * 65536 + get_byte(v_bytes, 1) * 256 + get_byte(v_bytes, 2)) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.device_pairing d where d.code = v_code);
  end loop;
  insert into public.device_pairing (code, token_hash, hint, agent, source)
  values (v_code, p_token_hash, p_hint, left(p_agent, 40), p_source)
  returning * into v_row;
  return jsonb_build_object('status', 'waiting', 'code', v_row.code, 'expires_at', v_row.expires_at);
end;
$$;

-- 'paired' (with the device's id, its name and the household's, which the installer shows so a
-- wrong pairing is noticed at once) once the owner typed the code; 'waiting'; or 'expired'.
create function public.rpc_media_pair_poll(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
begin
  select d.* into v_dev from public.media_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null;
  if found then
    return jsonb_build_object('status', 'paired', 'device_id', v_dev.id, 'name', v_dev.name,
                              'household', (select h.name from public.household h where h.id = v_dev.household_id));
  end if;
  if exists (select 1 from public.device_pairing d where d.token_hash = p_token_hash and d.expires_at >= now()) then
    return jsonb_build_object('status', 'waiting');
  end if;
  return jsonb_build_object('status', 'expired');
end;
$$;

revoke execute on function public.rpc_media_pair_start(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_media_pair_poll(text) from public, anon, authenticated;
grant execute on function public.rpc_media_pair_start(text, text, text, text) to service_role;
grant execute on function public.rpc_media_pair_poll(text) to service_role;

-- ── Pairing, the owner's side ─────────────────────────────────────────────────
-- GDPCN: no waiting speaker has that code (wrong, or older than 10 minutes). GDRTE: 10 wrong codes
-- in 10 minutes from this household, or 30 from everyone (guessing a 6-digit code within its 10
-- minutes is then out of reach). Calls are serialised, so the limits can't be raced. At most 2
-- speakers per household.
create function public.rpc_device_pair(p_household uuid, p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair public.device_pairing%rowtype;
  v_id   uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if p_household is null or not private.is_owner(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('gedara.device_pairing'));
  if (select count(*) from public.device_pair_attempt a
       where a.household_id = p_household and a.at > now() - interval '10 minutes') >= 10
     or (select count(*) from public.device_pair_attempt a where a.at > now() - interval '10 minutes') >= 30 then
    raise exception 'too many wrong codes, wait 10 minutes' using errcode = 'GDRTE';
  end if;
  if length(v_name) not between 1 and 40 then
    raise exception 'name must be 1–40 characters' using errcode = '23514';
  end if;
  select * into v_pair from public.device_pairing d
   where d.code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g') and d.expires_at >= now()
   for update;
  if not found then
    insert into public.device_pair_attempt (household_id) values (p_household);
    -- The wrong try must stay counted, so this is a result, not an exception (which would roll it back).
    return jsonb_build_object('ok', false, 'error', 'GDPCN');
  end if;
  if (select count(*) from public.device d
       where d.household_id = p_household and d.kind = 'media' and d.revoked_at is null) >= 2 then
    raise exception 'at most 2 speakers' using errcode = '23514';
  end if;
  insert into public.device (household_id, kind, name, token_hint, settings, fw_version)
  values (p_household, 'media', v_name, v_pair.hint,
          '{"volume_max": 80, "fade_s": 8, "normalise": true}', left(v_pair.agent, 32))
  returning id into v_id;
  insert into public.media_token (device_id, household_id, token_hash) values (v_id, p_household, v_pair.token_hash);
  delete from public.device_pairing d where d.id = v_pair.id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function public.rpc_device_pair(uuid, text, text) from public, anon;
grant execute on function public.rpc_device_pair(uuid, text, text) to authenticated;

update public.app_meta set value = '70' where key = 'schema_version';
