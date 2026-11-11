-- Phase 11 · 105 — the bin scanner: a fourth kind of device (devices/bin-scanner, docs/bin-scanner)
-- A barcode scanner next to the kitchen bin (ESP32 + GM861S + keypad + OLED + buzzer). Like the
-- scale it gets a 43-character key that is shown once; only the sha256 is kept. Scanner keys live in
-- their own table `scanner_token` (as the speaker's and the bridge's do), so a scanner's key can
-- never be used on the scale's endpoint, and a scale's key never on the scanner's.
-- Adding, removing and resuming a paused scanner is owner-only; members may rename it, change its
-- sound and pause it. Firmware is uploaded like the scale's, into `<household>/scanner/<version>.bin`.

alter table public.device drop constraint device_kind_check;
alter table public.device add constraint device_kind_check check (kind in ('scale', 'media', 'home', 'scanner'));

-- A paused scanner still stores what it reads, but nothing changes stock until the owner resumes it
-- (set by a member, or by the limits of migration 108 when a key behaves strangely).
alter table public.device
  add column paused_at     timestamptz,
  add column paused_reason text check (paused_reason in ('manual', 'minute', 'day', 'add_day'));

create table public.scanner_token (
  device_id    uuid primary key references public.device (id) on delete cascade,
  household_id uuid not null references public.household (id) on delete cascade,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$')
);
create index scanner_token_household_idx on public.scanner_token (household_id);
alter table public.scanner_token enable row level security;
revoke all on table public.scanner_token from anon, authenticated;
-- No grants and no policies: only SECURITY DEFINER functions read it.

-- ── Settings the scanner downloads ────────────────────────────────────────────
--   volume 0–100 · quiet_from / quiet_to "HH:MM" · eye: sense (lamp only when something moves) /
--   always / key (only after a key press) · eye_quiet: same / key (during quiet hours) ·
--   mode_s: seconds before Add / Opened / Waste / Check fall back to Used · buzzer: passive / active ·
--   bright 0–100 · night_off: screen off in quiet hours until a key or a scan ·
--   keymap: the 16 keys row by row (lets a differently wired keypad be fixed without rewiring).
create function private.scanner_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k not in ('volume', 'quiet_from', 'quiet_to', 'eye', 'eye_quiet', 'mode_s', 'buzzer', 'bright',
                           'night_off', 'keymap')) = 0
     and (not p ? 'volume' or (jsonb_typeof(p -> 'volume') = 'number'
                               and (p ->> 'volume')::numeric between 0 and 100
                               and (p ->> 'volume')::numeric = trunc((p ->> 'volume')::numeric)))
     and (not p ? 'quiet_from' or coalesce(p ->> 'quiet_from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'quiet_to' or coalesce(p ->> 'quiet_to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'eye' or coalesce(p ->> 'eye', '') in ('sense', 'always', 'key'))
     and (not p ? 'eye_quiet' or coalesce(p ->> 'eye_quiet', '') in ('same', 'key'))
     and (not p ? 'mode_s' or (jsonb_typeof(p -> 'mode_s') = 'number'
                               and (p ->> 'mode_s')::numeric between 10 and 120
                               and (p ->> 'mode_s')::numeric = trunc((p ->> 'mode_s')::numeric)))
     and (not p ? 'buzzer' or coalesce(p ->> 'buzzer', '') in ('passive', 'active'))
     and (not p ? 'bright' or (jsonb_typeof(p -> 'bright') = 'number'
                               and (p ->> 'bright')::numeric between 0 and 100
                               and (p ->> 'bright')::numeric = trunc((p ->> 'bright')::numeric)))
     and (not p ? 'night_off' or jsonb_typeof(p -> 'night_off') = 'boolean')
     -- every one of the 16 keys exactly once
     and (not p ? 'keymap' or (coalesce(p ->> 'keymap', '') ~ '^[0-9A-D*#]{16}$'
                               and (select count(distinct c) from regexp_split_to_table(p ->> 'keymap', '') c) = 16))
$$;
revoke execute on function private.scanner_settings_valid(jsonb) from public, anon, authenticated;

-- ── rpc_scanner_create: returns the plain key exactly once (owner) ────────────
create function public.rpc_scanner_create(p_household uuid, p_name text)
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
  if (select count(*) from public.device d
       where d.household_id = p_household and d.kind = 'scanner' and d.revoked_at is null) >= 3 then
    raise exception 'at most 3 active scanners' using errcode = '23514';
  end if;
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.device (household_id, kind, name, token_hint, settings)
  values (p_household, 'scanner', btrim(p_name), right(v_token, 4),
          '{"volume": 60, "quiet_from": "22:00", "quiet_to": "06:00", "eye": "sense", "eye_quiet": "same", "mode_s": 30,
            "buzzer": "passive", "bright": 80, "night_off": true, "keymap": "123A456B789C*0#D"}'::jsonb)
  returning id into v_id;
  insert into public.scanner_token (device_id, household_id, token_hash)
  values (v_id, p_household, encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'));
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;
revoke execute on function public.rpc_scanner_create(uuid, text) from public, anon;
grant execute on function public.rpc_scanner_create(uuid, text) to authenticated;

-- ── rpc_device_update: as in migration 75, plus the scanner's settings ────────
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
                            when 'scanner' then private.scanner_settings_valid(v_settings)
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

-- ── rpc_device_revoke: as in migration 97, also forgets a scanner's key ───────
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
  delete from public.scanner_token t where t.device_id = p_id;
  delete from public.home_entity h where h.device_id = p_id;
end;
$$;

-- ── Firmware for two kinds of device ──────────────────────────────────────────
-- The scanner's board has 4 MB of flash: two app slots of 1.75 MB.
alter table public.device_firmware drop constraint device_firmware_kind_check;
alter table public.device_firmware drop constraint device_firmware_project_check;
alter table public.device_firmware drop constraint device_firmware_size_check;
alter table public.device_firmware
  add constraint device_firmware_kind_check check (kind in ('scale', 'scanner')),
  add constraint device_firmware_project_check
    check ((kind = 'scale' and project = 'gedara-kitchen-scale') or (kind = 'scanner' and project = 'gedara-bin-scanner')),
  add constraint device_firmware_size_check
    check (size >= 65536 and size <= case kind when 'scanner' then 1835008 else 3145728 end);

drop policy device_firmware_insert on storage.objects;
create policy device_firmware_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'device-firmware'
              and private.is_owner(public.safe_uuid((storage.foldername(name))[1]))
              and (storage.foldername(name))[2] in ('scale', 'scanner'));

-- As in migration 66; the kind is the folder the file was uploaded into.
create or replace function public.rpc_device_firmware_add(p_household uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := p ->> 'path';
  v_kind text;
  v_size bigint;
  v_id   uuid;
begin
  if p_household is null or not private.is_owner(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_path is null or v_path !~ ('^' || p_household::text || '/(scale|scanner)/[0-9A-Za-z.+-]{5,40}\.bin$') then
    raise exception 'bad firmware path' using errcode = '23514';
  end if;
  v_kind := split_part(v_path, '/', 2);
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o where o.bucket_id = 'device-firmware' and o.name = v_path;
  if not found then
    raise exception 'upload the file first' using errcode = '23503';
  end if;
  if v_size is distinct from (p ->> 'size')::bigint then
    raise exception 'the uploaded file doesn''t match' using errcode = '23514';
  end if;
  insert into public.device_firmware (household_id, kind, version, project, sha256, size, path, notes)
  values (p_household, v_kind, p ->> 'version', p ->> 'project', lower(p ->> 'sha256'), v_size, v_path,
          nullif(btrim(p ->> 'notes'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ── rpc_device_command: as in migration 65, per kind ──────────────────────────
-- Scale: tare · calibrate · beep · identify (members); reboot · ota (owner).
-- Scanner: beep · identify (members); reboot · ota (owner). An update must be firmware of that kind.
create or replace function public.rpc_device_command(p_device uuid, p_command text, p_args jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev  public.device%rowtype;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_id   uuid;
begin
  select * into v_dev from public.device d where d.id = p_device and d.revoked_at is null for update;
  if not found or not private.can_write(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_dev.kind not in ('scale', 'scanner') then
    raise exception 'this device takes no commands' using errcode = '23514';
  end if;
  if p_command is null or p_command not in ('tare', 'calibrate', 'beep', 'identify', 'reboot', 'ota')
     or (v_dev.kind = 'scanner' and p_command in ('tare', 'calibrate')) then
    raise exception 'unknown command' using errcode = '23514';
  end if;
  if p_command in ('reboot', 'ota') and not private.is_owner(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_command = 'calibrate' then
    if jsonb_typeof(v_args -> 'known_g') <> 'number' or (v_args ->> 'known_g')::numeric not between 50 and 5000 then
      raise exception 'known weight must be 50 g to 5 kg' using errcode = '23514';
    end if;
    v_args := jsonb_build_object('known_g', round((v_args ->> 'known_g')::numeric, 1));
  elsif p_command = 'ota' then
    if not exists (select 1 from public.device_firmware f
                    where f.id = (v_args ->> 'firmware_id')::uuid and f.household_id = v_dev.household_id
                      and f.kind = v_dev.kind) then
      raise exception 'unknown firmware' using errcode = '23503';
    end if;
    v_args := jsonb_build_object('firmware_id', v_args ->> 'firmware_id');
  else
    v_args := '{}'::jsonb;
  end if;

  -- One of each at a time: a newer request replaces an older one still waiting.
  update public.device_command c set status = 'expired'
   where c.device_id = p_device and c.command = p_command and c.status in ('queued', 'sent');
  insert into public.device_command (household_id, device_id, command, args)
  values (v_dev.household_id, p_device, p_command, v_args)
  returning id into v_id;
  update public.device d set watch_until = greatest(coalesce(d.watch_until, now()), now() + interval '2 minutes')
   where d.id = p_device;
  return v_id;
end;
$$;

update public.app_meta set value = '105' where key = 'schema_version';
