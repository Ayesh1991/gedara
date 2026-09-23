-- Phase 1 · 9 — attachment: one table for every file in the system (MASTER_PLAN §3.7, §7e)
-- Phase 1 uses it for place photos. Files live in the `household-files` bucket at
-- {household_id}/{entity_type}/{entity_id}/{uuid}.webp (+ {uuid}.thumb.webp); Drive overflow
-- (provider 'gdrive') arrives with Phase 5.

create table public.attachment (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  entity_type   text not null check (entity_type in ('product', 'lot', 'asset', 'location', 'transaction', 'maintenance')),
  entity_id     uuid not null,
  kind          text not null default 'photo'
                check (kind in ('photo', 'receipt', 'warranty', 'manual', 'invoice', 'label', 'other')),
  provider      text not null default 'supabase' check (provider in ('supabase', 'gdrive')),
  storage_path  text not null,
  thumb_path    text,
  drive_file_id text,
  mime          text check (mime in ('image/webp', 'image/jpeg', 'image/png', 'application/pdf')),
  bytes         integer check (bytes >= 0),
  width         integer check (width > 0),
  height        integer check (height > 0),
  is_primary    boolean not null default false,
  ocr_json      jsonb,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  -- Supabase files must sit inside the household's own folder (storage RLS keys on that segment).
  check (provider <> 'supabase' or (
    starts_with(storage_path, household_id::text || '/')
    and (thumb_path is null or starts_with(thumb_path, household_id::text || '/'))
  )),
  check (provider <> 'gdrive' or drive_file_id is not null)
);

create index attachment_entity_idx on public.attachment (household_id, entity_type, entity_id);
create index attachment_created_by_idx on public.attachment (created_by);
-- One primary photo per entity (the tile / hero image).
create unique index attachment_one_primary_idx on public.attachment (entity_type, entity_id) where is_primary;

-- Deleting a place removes its attachment rows (the client removes the files, best effort).
create function private.location_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'location' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger location_delete_attachments
  after delete on public.location
  for each row execute function private.location_delete_attachments();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.attachment enable row level security;

revoke all on table public.attachment from anon, authenticated;
grant select, delete on table public.attachment to authenticated;
grant insert (household_id, entity_type, entity_id, kind, provider, storage_path, thumb_path,
              drive_file_id, mime, bytes, width, height, is_primary)
  on table public.attachment to authenticated;
grant update (kind, is_primary) on table public.attachment to authenticated;

create policy attachment_select on public.attachment
  for select to authenticated
  using (private.is_member(household_id));

create policy attachment_insert on public.attachment
  for insert to authenticated
  with check (private.can_write(household_id));

create policy attachment_update on public.attachment
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy attachment_delete on public.attachment
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '9' where key = 'schema_version';
