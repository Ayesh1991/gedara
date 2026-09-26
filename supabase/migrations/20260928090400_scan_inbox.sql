-- Phase 7 · 54 — scanned files from Google Drive (MASTER_PLAN §7 item 1, decided 2026-09-25)
-- Bills, warranty cards and appliance rating plates are read by the claude.ai "Bill Scanner"
-- project, which saves its JSON into a Drive folder. The `drive-scan` Edge Function reads that
-- folder with a read-only Google service account and stores what it found here, already validated
-- (Zod) and with the ledger-v7 fingerprints of every bill in the file.
--
-- Nothing reaches the ledger from here: a person opens the file in Money › Import and confirms it,
-- exactly like a pasted JSON. The file's status is derived, not stored (like the SMS inbox):
--   ignored  — someone pressed "Ignore"
--   error    — the file couldn't be read / validated
--   imported — every bill's fingerprint is in money_transaction (or, for a warranty card / rating
--              plate, it was applied to a thing)
--   waiting  — anything else

-- ── Where to look (owner sets the folder once) ────────────────────────────────
create table public.drive_source (
  household_id uuid primary key references public.household (id) on delete cascade,
  folder_id    text not null check (folder_id ~ '^[A-Za-z0-9_-]{10,100}$'),
  last_sync_at timestamptz,
  last_error   text check (length(last_error) <= 500),
  updated_by   uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now()
);

create index drive_source_updated_by_idx on public.drive_source (updated_by);

create trigger drive_source_updated_at
  before update on public.drive_source
  for each row execute function private.set_updated_at();

alter table public.drive_source enable row level security;

revoke all on table public.drive_source from anon, authenticated;
grant select, delete on table public.drive_source to authenticated;
grant insert (household_id, folder_id) on table public.drive_source to authenticated;
grant update (folder_id) on table public.drive_source to authenticated;

create policy drive_source_select on public.drive_source for select to authenticated
  using (private.is_member(household_id));
create policy drive_source_insert on public.drive_source for insert to authenticated
  with check (private.is_owner(household_id));
create policy drive_source_update on public.drive_source for update to authenticated
  using (private.is_owner(household_id)) with check (private.is_owner(household_id));
create policy drive_source_delete on public.drive_source for delete to authenticated
  using (private.is_owner(household_id));

-- ── The files ────────────────────────────────────────────────────────────────
create table public.scan_file (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  name          text not null check (length(name) between 1 and 300),
  mime          text not null check (length(mime) between 3 and 100),
  modified_at   timestamptz not null,
  doc_type      text check (doc_type in ('bill', 'warranty', 'rating_plate')),
  payload       jsonb check (payload is null or jsonb_typeof(payload) in ('object', 'array')),
  bill_fps      text[] not null default '{}',
  parse_error   text check (length(parse_error) <= 500),
  asset_id      uuid,                                     -- warranty / plate: the thing it filled in
  ignored_at    timestamptz,
  ignored_by    uuid references auth.users (id) on delete set null,
  seen_at       timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, drive_file_id),
  unique (household_id, id),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete set null (asset_id),
  check ((payload is null) = (parse_error is not null)),
  check (payload is null or doc_type is not null),
  check (cardinality(bill_fps) <= 200 and array_to_string(bill_fps, ' ') ~ '^[A-Za-z0-9~_ -]*$')
);

create index scan_file_household_idx on public.scan_file (household_id, modified_at desc);
create index scan_file_asset_idx on public.scan_file (household_id, asset_id) where asset_id is not null;
create index scan_file_ignored_by_idx on public.scan_file (ignored_by) where ignored_by is not null;

create trigger scan_file_updated_at
  before update on public.scan_file
  for each row execute function private.set_updated_at();

alter table public.scan_file enable row level security;

revoke all on table public.scan_file from anon, authenticated;
grant select on table public.scan_file to authenticated;

create policy scan_file_select on public.scan_file for select to authenticated
  using (private.is_member(household_id));

-- ── Derived status ───────────────────────────────────────────────────────────
create view public.v_scan_file
with (security_invoker = true)
as
select f.id, f.household_id, f.drive_file_id, f.name, f.mime, f.modified_at, f.doc_type, f.payload,
       f.bill_fps, f.parse_error, f.asset_id, f.ignored_at, f.seen_at,
       cardinality(f.bill_fps) as bills_total,
       b.imported as bills_imported,
       case
         when f.ignored_at is not null then 'ignored'
         when f.payload is null then 'error'
         when f.doc_type = 'bill' and b.imported >= cardinality(f.bill_fps) then 'imported'
         when f.doc_type <> 'bill' and f.asset_id is not null then 'imported'
         else 'waiting'
       end as status
  from public.scan_file f
  cross join lateral (
    select count(*)::integer as imported
      from unnest(f.bill_fps) fp
     where exists (select 1 from public.money_transaction t
                    where t.household_id = f.household_id and t.fingerprint = fp)
  ) b;

grant select on public.v_scan_file to authenticated;

-- ── RPCs (the Edge Function calls these with the signed-in user's JWT) ───────
-- Start a sync: returns the folder and what is already known, or go=false when the last sync was
-- less than 5 minutes ago (30 s when the person pressed "Check now").
create function public.rpc_scan_sync_begin(p_household uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.drive_source%rowtype;
  v_wait interval := case when p_force then interval '30 seconds' else interval '5 minutes' end;
begin
  if p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v from public.drive_source s where s.household_id = p_household for update;
  if not found then
    return jsonb_build_object('go', false, 'reason', 'no_folder');
  end if;
  if v.last_sync_at is not null and v.last_sync_at > now() - v_wait then
    return jsonb_build_object('go', false, 'reason', 'recent', 'last_sync_at', v.last_sync_at);
  end if;

  update public.drive_source s set last_sync_at = now() where s.household_id = p_household;
  return jsonb_build_object(
    'go', true,
    'folder_id', v.folder_id,
    'known', coalesce((select jsonb_object_agg(f.drive_file_id, f.modified_at)
                         from public.scan_file f where f.household_id = p_household), '{}'::jsonb));
end;
$$;

-- Store what the function read. Any writer of the household could call this directly, which is no
-- more than pasting JSON into Import: the web app validates the payload again (Zod) before use.
-- p_files: [{drive_file_id, name, mime, modified_at, doc_type?,
-- payload?, bill_fps?, parse_error?}]. A changed file is replaced; "Ignore" and the thing link stay.
create function public.rpc_scan_files_upsert(p_household uuid, p_files jsonb, p_error text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  f   jsonb;
begin
  if p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 200 then
    raise exception 'files must be an array of at most 200' using errcode = '23514';
  end if;

  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    insert into public.scan_file as s
      (household_id, drive_file_id, name, mime, modified_at, doc_type, payload, bill_fps, parse_error)
    values
      (p_household, f ->> 'drive_file_id', left(f ->> 'name', 300), f ->> 'mime', (f ->> 'modified_at')::timestamptz,
       f ->> 'doc_type', f -> 'payload',
       coalesce((select array_agg(x) from jsonb_array_elements_text(f -> 'bill_fps') x), '{}'),
       left(f ->> 'parse_error', 500))
    on conflict (household_id, drive_file_id) do update
      set name = excluded.name, mime = excluded.mime, modified_at = excluded.modified_at,
          doc_type = excluded.doc_type, payload = excluded.payload, bill_fps = excluded.bill_fps,
          parse_error = excluded.parse_error, seen_at = now();
    v_n := v_n + 1;
  end loop;

  update public.drive_source s set last_error = left(p_error, 500) where s.household_id = p_household;
  return v_n;
end;
$$;

-- "Ignore" / "Show again".
create function public.rpc_scan_file_ignore(p_file uuid, p_ignored boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select f.household_id into v_household from public.scan_file f where f.id = p_file;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.scan_file f
     set ignored_at = case when p_ignored then now() end,
         ignored_by = case when p_ignored then auth.uid() end
   where f.id = p_file;
end;
$$;

-- A warranty card / rating plate was applied to a thing (null = unlink).
create function public.rpc_scan_file_asset(p_file uuid, p_asset uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select f.household_id into v_household from public.scan_file f where f.id = p_file;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_asset is not null and not exists (select 1 from public.asset a where a.id = p_asset and a.household_id = v_household) then
    raise exception 'unknown thing' using errcode = '23503';
  end if;
  update public.scan_file f set asset_id = p_asset where f.id = p_file;
end;
$$;

revoke execute on function public.rpc_scan_sync_begin(uuid, boolean) from public, anon;
revoke execute on function public.rpc_scan_files_upsert(uuid, jsonb, text) from public, anon;
revoke execute on function public.rpc_scan_file_ignore(uuid, boolean) from public, anon;
revoke execute on function public.rpc_scan_file_asset(uuid, uuid) from public, anon;
grant execute on function public.rpc_scan_sync_begin(uuid, boolean) to authenticated;
grant execute on function public.rpc_scan_files_upsert(uuid, jsonb, text) to authenticated;
grant execute on function public.rpc_scan_file_ignore(uuid, boolean) to authenticated;
grant execute on function public.rpc_scan_file_asset(uuid, uuid) to authenticated;

update public.app_meta set value = '54' where key = 'schema_version';
