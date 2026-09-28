-- Phase 7d · 60 — more place kinds, and the household's own place types (MASTER_PLAN §3.3)
-- Didula also keeps things in cupboards, on racks and in document files, and wants to add a type
-- of his own ("Tool wall", "Suitcase" …) where he picks one. Built-in kinds stay a fixed list (the
-- app knows their icons and wording in every language); a household's own types live in
-- `place_type` and a place points at one with `type_id` (same household, like every reference).

alter table public.location drop constraint location_kind_check;
alter table public.location
  add constraint location_kind_check
  check (kind in ('room', 'furniture', 'container', 'drawer', 'shelf', 'zone', 'vehicle', 'offsite',
                  'cupboard', 'rack', 'file'));

create table public.place_type (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 40),
  -- One of the app's icon choices (lucide names).
  icon         text not null default 'box'
                 check (icon in ('box', 'archive', 'folder', 'book', 'briefcase', 'package', 'shopping-bag',
                                 'refrigerator', 'bed', 'car', 'warehouse', 'wrench', 'shirt', 'utensils',
                                 'lamp', 'tv')),
  sort         integer not null default 0,
  archived     boolean not null default false,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, id)
);

-- Names are unique per household, whatever the case or spacing ("Tool wall" = " tool  WALL").
create unique index place_type_name_idx on public.place_type (household_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));
create index place_type_created_by_idx on public.place_type (created_by);

create function private.place_type_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := regexp_replace(btrim(new.name), '\s+', ' ', 'g');
  return new;
end;
$$;

create trigger place_type_tidy
  before insert or update of name on public.place_type
  for each row execute function private.place_type_tidy();

create trigger place_type_updated_at
  before update on public.place_type
  for each row execute function private.set_updated_at();

revoke execute on function private.place_type_tidy() from public, anon, authenticated;

alter table public.place_type enable row level security;

revoke all on table public.place_type from anon, authenticated;
grant select, delete on table public.place_type to authenticated;
grant insert (id, household_id, name, icon, sort) on table public.place_type to authenticated;
grant update (name, icon, sort, archived) on table public.place_type to authenticated;

create policy place_type_select on public.place_type
  for select to authenticated
  using (private.is_member(household_id));

create policy place_type_insert on public.place_type
  for insert to authenticated
  with check (private.can_write(household_id));

create policy place_type_update on public.place_type
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy place_type_delete on public.place_type
  for delete to authenticated
  using (private.can_write(household_id));

-- A place is a built-in kind or one of the household's own types.
alter table public.location add column type_id uuid;
alter table public.location
  add constraint location_type_fk foreign key (household_id, type_id)
  references public.place_type (household_id, id) on delete set null (type_id);
create index location_type_idx on public.location (household_id, type_id) where type_id is not null;

grant insert (type_id), update (type_id) on table public.location to authenticated;

update public.app_meta set value = '60' where key = 'schema_version';
