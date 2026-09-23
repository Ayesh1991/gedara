-- Phase 0 · 4/5 — private Storage bucket for every household file (MASTER_PLAN §3.7)
-- Path convention: {household_id}/{entity_type}/{entity_id}/{uuid}.webp
-- Access rule: the first path segment must be a household the caller belongs to.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'household-files',
  'household-files',
  false,
  10485760, -- 10 MB; photos are compressed to WebP in the browser first (rule 9)
  array['image/webp', 'image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do nothing;

-- Casting a malformed path segment to uuid would raise; return null instead so the policy denies.
create function public.safe_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke execute on function public.safe_uuid(text) from public, anon;
grant execute on function public.safe_uuid(text) to authenticated;

create policy household_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'household-files'
    and public.is_member(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy household_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'household-files'
    and public.can_write(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy household_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'household-files'
    and public.can_write(public.safe_uuid((storage.foldername(name))[1]))
  )
  with check (
    bucket_id = 'household-files'
    and public.can_write(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy household_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'household-files'
    and public.can_write(public.safe_uuid((storage.foldername(name))[1]))
  );

update public.app_meta set value = '4' where key = 'schema_version';
