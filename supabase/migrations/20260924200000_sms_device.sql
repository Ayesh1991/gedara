-- Phase 2b · 18 — SMS forwarder devices
-- An Android phone running "SMS to URL Forwarder" posts bank alerts to the sms-ingest Edge Function
-- with a per-device secret token. Only the token's sha256 is stored; the token itself is shown once
-- when the device is added. Devices are a credential, so only the household owner adds or revokes
-- them. Members can see that a device exists (name, last seen) but never its hash.

create table public.sms_device (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.household (id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 40),
  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint           text not null check (length(token_hint) = 4),   -- last 4 characters, to tell tokens apart
  created_by           uuid default auth.uid() references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz,
  message_count        integer not null default 0,
  dropped_count        integer not null default 0,                     -- OTPs, promos, unknown senders
  last_rejected_sender text check (length(last_rejected_sender) <= 40),
  last_rejected_at     timestamptz,
  revoked_at           timestamptz,
  unique (household_id, id)
);

create index sms_device_household_idx on public.sms_device (household_id);
create index sms_device_created_by_idx on public.sms_device (created_by);

-- ── RLS + privileges: read-only to clients, token_hash never readable ─────────
alter table public.sms_device enable row level security;

revoke all on table public.sms_device from anon, authenticated;
grant select (id, household_id, name, token_hint, created_by, created_at, last_seen_at, message_count,
              dropped_count, last_rejected_sender, last_rejected_at, revoked_at)
  on table public.sms_device to authenticated;

create policy sms_device_select on public.sms_device
  for select to authenticated
  using (private.is_member(household_id));

-- ── rpc_sms_device_create: returns the plain token exactly once ──────────────
create function public.rpc_sms_device_create(p_household uuid, p_name text)
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
  if (select count(*) from public.sms_device d where d.household_id = p_household and d.revoked_at is null) >= 5 then
    raise exception 'at most 5 active devices' using errcode = '23514';
  end if;
  -- 32 random bytes, base64url without padding (43 characters).
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.sms_device (household_id, name, token_hash, token_hint)
  values (p_household, btrim(p_name),
          encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), right(v_token, 4))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;

create function public.rpc_sms_device_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select d.household_id into v_household from public.sms_device d where d.id = p_id;
  if v_household is null or not private.is_owner(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.sms_device d set revoked_at = coalesce(d.revoked_at, now()) where d.id = p_id;
end;
$$;

revoke execute on function public.rpc_sms_device_create(uuid, text) from public, anon;
revoke execute on function public.rpc_sms_device_revoke(uuid) from public, anon;
grant execute on function public.rpc_sms_device_create(uuid, text) to authenticated;
grant execute on function public.rpc_sms_device_revoke(uuid) to authenticated;

update public.app_meta set value = '18' where key = 'schema_version';
