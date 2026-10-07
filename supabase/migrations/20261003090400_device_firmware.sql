-- Phase 6b · 66 — firmware updates for the scale (Didula, 2026-10-03: upload on the website, install on tap)
-- The owner uploads firmware.bin (built in VS Code) into the private bucket `device-firmware` under
-- `<household>/scale/<version>.bin`; the browser reads the version and project name from the image
-- and computes its sha256. "Install" queues an `ota` command; scale-ingest hands the device a link
-- signed for 10 minutes plus the sha256, and the device checks it before switching (and rolls back
-- by itself if the new version can't reach Gedara).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('device-firmware', 'device-firmware', false, 4194304, array['application/octet-stream'])
on conflict (id) do nothing;

create policy device_firmware_select on storage.objects
  for select to authenticated
  using (bucket_id = 'device-firmware'
         and private.is_member(public.safe_uuid((storage.foldername(name))[1])));

create policy device_firmware_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'device-firmware'
              and private.is_owner(public.safe_uuid((storage.foldername(name))[1]))
              and (storage.foldername(name))[2] = 'scale');

create policy device_firmware_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'device-firmware'
         and private.is_owner(public.safe_uuid((storage.foldername(name))[1])));

create table public.device_firmware (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  kind         text not null default 'scale' check (kind in ('scale')),
  version      text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,20})?$'),
  project      text not null check (project = 'gedara-kitchen-scale'),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size         integer not null check (size between 65536 and 3145728),   -- fits one 3 MB app slot
  path         text not null unique,
  notes        text check (length(notes) <= 500),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, kind, version)
);

create index device_firmware_created_by_idx on public.device_firmware (created_by);

alter table public.device_firmware enable row level security;
revoke all on table public.device_firmware from anon, authenticated;
grant select on table public.device_firmware to authenticated;

create policy device_firmware_row_select on public.device_firmware
  for select to authenticated
  using (private.is_member(household_id));

-- Registers an uploaded file. The object must exist at the household's own path and have the size
-- the browser measured.
create function public.rpc_device_firmware_add(p_household uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := p ->> 'path';
  v_size bigint;
  v_id   uuid;
begin
  if p_household is null or not private.is_owner(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_path is null or v_path !~ ('^' || p_household::text || '/scale/[0-9A-Za-z.+-]{5,40}\.bin$') then
    raise exception 'bad firmware path' using errcode = '23514';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o where o.bucket_id = 'device-firmware' and o.name = v_path;
  if not found then
    raise exception 'upload the file first' using errcode = '23503';
  end if;
  if v_size is distinct from (p ->> 'size')::bigint then
    raise exception 'the uploaded file doesn''t match' using errcode = '23514';
  end if;
  insert into public.device_firmware (household_id, version, project, sha256, size, path, notes)
  values (p_household, p ->> 'version', p ->> 'project', lower(p ->> 'sha256'), v_size, v_path,
          nullif(btrim(p ->> 'notes'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.rpc_device_firmware_add(uuid, jsonb) from public, anon;
grant execute on function public.rpc_device_firmware_add(uuid, jsonb) to authenticated;

update public.app_meta set value = '66' where key = 'schema_version';
