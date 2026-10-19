-- Phase 8 · 75 — the Home Assistant bridge (devices/home-bridge on the Gedara Pi 2): a third kind of
-- device, paired with an 8-digit code exactly like the music speaker (migration 70).
--
-- The bridge makes its own key and sends only its sha256 to the home-agent Edge Function. Bridge keys
-- live in their own table `home_token`, so a speaker's or the scale's key can never be used on the
-- home RPCs, and vice versa. The Home Assistant access token never comes here: it stays on the Pi.
-- At most one bridge per household.

alter table public.device drop constraint device_kind_check;
alter table public.device add constraint device_kind_check check (kind in ('scale', 'media', 'home'));

create table public.home_token (
  device_id    uuid primary key references public.device (id) on delete cascade,
  household_id uuid not null references public.household (id) on delete cascade,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$')
);
create index home_token_household_idx on public.home_token (household_id);
alter table public.home_token enable row level security;
revoke all on table public.home_token from anon, authenticated;

alter table public.device_pairing drop constraint device_pairing_kind_check;
alter table public.device_pairing add constraint device_pairing_kind_check check (kind in ('media', 'home'));

-- ── Settings: the bridge has none (rpc_device_update may only rename it) ──────
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
                            when 'home' then v_settings = '{}'::jsonb
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

-- Same as migration 70; also forgets a bridge's key.
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
  delete from public.home_token t where t.device_id = p_id;
end;
$$;

-- ── Pairing, the Pi's side (service role only: called by the home-agent function) ─────────────
-- Same rules as rpc_media_pair_start: the same code if asked twice, at most 3 waiting per caller
-- and 100 in all (GDRTE).
create function public.rpc_home_pair_start(p_token_hash text, p_hint text, p_agent text default null,
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
  if exists (select 1 from public.home_token t where t.token_hash = p_token_hash) then
    return jsonb_build_object('status', 'paired');
  end if;
  delete from public.device_pairing d where d.expires_at < now();
  select * into v_row from public.device_pairing d where d.token_hash = p_token_hash;
  if found then
    if v_row.kind <> 'home' then
      raise exception 'bad pairing request' using errcode = '23514';
    end if;
    return jsonb_build_object('status', 'waiting', 'code', v_row.code, 'expires_at', v_row.expires_at);
  end if;
  if p_source is not null and (select count(*) from public.device_pairing d where d.source = p_source) >= 3 then
    raise exception 'too many pairings waiting from here' using errcode = 'GDRTE';
  end if;
  if (select count(*) from public.device_pairing) >= 100 then
    raise exception 'too many pairings waiting' using errcode = 'GDRTE';
  end if;
  loop
    v_bytes := extensions.gen_random_bytes(4);
    v_code := lpad(((get_byte(v_bytes, 0)::bigint * 16777216 + get_byte(v_bytes, 1) * 65536
                     + get_byte(v_bytes, 2) * 256 + get_byte(v_bytes, 3)) % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.device_pairing d where d.code = v_code);
  end loop;
  insert into public.device_pairing (kind, code, token_hash, hint, agent, source)
  values ('home', v_code, p_token_hash, p_hint, left(p_agent, 40), p_source)
  returning * into v_row;
  return jsonb_build_object('status', 'waiting', 'code', v_row.code, 'expires_at', v_row.expires_at);
end;
$$;

create function public.rpc_home_pair_poll(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
begin
  select d.* into v_dev from public.home_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null;
  if found then
    return jsonb_build_object('status', 'paired', 'device_id', v_dev.id, 'name', v_dev.name,
                              'household', (select h.name from public.household h where h.id = v_dev.household_id));
  end if;
  if exists (select 1 from public.device_pairing d where d.token_hash = p_token_hash and d.kind = 'home'
              and d.expires_at >= now()) then
    return jsonb_build_object('status', 'waiting');
  end if;
  return jsonb_build_object('status', 'expired');
end;
$$;

revoke execute on function public.rpc_home_pair_start(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_home_pair_poll(text) from public, anon, authenticated;
grant execute on function public.rpc_home_pair_start(text, text, text, text) to service_role;
grant execute on function public.rpc_home_pair_poll(text) to service_role;

-- ── Pairing, the owner's side ─────────────────────────────────────────────────
-- Migration 70's rules (owner only, 10 wrong codes per 10 minutes, serialised), now for both kinds:
-- the device gets the kind of the pairing it was typed for. p_kind (what the sheet was opened for)
-- must match, so a bridge's code typed into "Add speaker" says "wrong code" instead of pairing the
-- wrong thing. At most 2 speakers and 1 Home Assistant bridge per household.
drop function public.rpc_device_pair(uuid, text, text);
create function public.rpc_device_pair(p_household uuid, p_code text, p_name text, p_kind text default 'media')
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
  if coalesce(p_kind, '') not in ('media', 'home') then
    raise exception 'unknown kind of device' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('gedara.device_pairing'));
  if (select count(*) from public.device_pair_attempt a
       where a.household_id = p_household and a.at > now() - interval '10 minutes') >= 10 then
    raise exception 'too many wrong codes, wait 10 minutes' using errcode = 'GDRTE';
  end if;
  if length(v_name) not between 1 and 40 then
    raise exception 'name must be 1–40 characters' using errcode = '23514';
  end if;
  select * into v_pair from public.device_pairing d
   where d.code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g') and d.expires_at >= now() and d.kind = p_kind
   for update;
  if not found then
    insert into public.device_pair_attempt (household_id) values (p_household);
    -- The wrong try must stay counted, so this is a result, not an exception (which would roll it back).
    return jsonb_build_object('ok', false, 'error', 'GDPCN');
  end if;
  if v_pair.kind = 'media' and (select count(*) from public.device d
       where d.household_id = p_household and d.kind = 'media' and d.revoked_at is null) >= 2 then
    raise exception 'at most 2 speakers' using errcode = '23514';
  end if;
  if v_pair.kind = 'home' and exists (select 1 from public.device d
       where d.household_id = p_household and d.kind = 'home' and d.revoked_at is null) then
    raise exception 'one Home Assistant bridge per household' using errcode = '23514';
  end if;
  insert into public.device (household_id, kind, name, token_hint, settings, fw_version)
  values (p_household, v_pair.kind, v_name, v_pair.hint,
          case v_pair.kind when 'media' then '{"volume_max": 80, "fade_s": 8, "normalise": true}'::jsonb else '{}'::jsonb end,
          left(v_pair.agent, 32))
  returning id into v_id;
  if v_pair.kind = 'media' then
    insert into public.media_token (device_id, household_id, token_hash) values (v_id, p_household, v_pair.token_hash);
  else
    insert into public.home_token (device_id, household_id, token_hash) values (v_id, p_household, v_pair.token_hash);
  end if;
  delete from public.device_pairing d where d.id = v_pair.id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke execute on function public.rpc_device_pair(uuid, text, text, text) from public, anon;
grant execute on function public.rpc_device_pair(uuid, text, text, text) to authenticated;

update public.app_meta set value = '75' where key = 'schema_version';
