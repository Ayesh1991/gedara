-- Phase 1 · 8 — location tree + QR codes (MASTER_PLAN §3.3)
-- Rooms → furniture → boxes. Every place gets an immutable HL:LOC code for its printed label and a
-- materialised breadcrumb `path` ("Kitchen › Pantry cupboard › Box 3") kept by triggers.

create table public.location (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  parent_id    uuid,
  name         text not null check (length(btrim(name)) between 1 and 80),
  kind         text check (kind in ('room', 'furniture', 'container', 'drawer', 'shelf', 'zone', 'vehicle', 'offsite')),
  code         text not null unique check (code ~ '^HL:LOC:[0-9A-HJKMNP-TV-Z]{6}$'),
  climate      text check (climate in ('ambient', 'fridge', 'freezer', 'dry', 'humid')),
  notes        text check (length(notes) <= 2000),
  sort         integer not null default 0,
  map_x        numeric,
  map_y        numeric,
  path         text not null,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Target of the composite FK below (and of later tables that point at a place in the same household).
  unique (household_id, id),
  -- A parent must belong to the same household. NO ACTION (default) blocks deleting a place that
  -- still has places inside it, while a household delete still cascades through the whole tree.
  foreign key (household_id, parent_id) references public.location (household_id, id)
);

create index location_parent_idx on public.location (household_id, parent_id);
create index location_created_by_idx on public.location (created_by);

-- ── Triggers ──────────────────────────────────────────────────────────────────

-- Code is assigned here, never by the client (column privileges below don't allow it anyway).
create function private.location_assign_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.code := private.new_hl_code('LOC', 'public.location'::regclass);
  return new;
end;
$$;

-- Own path from the parent's path; rejects moving a place into itself or its own descendants.
create function private.location_set_path()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_path text;
begin
  new.name := btrim(new.name);

  if new.parent_id is null then
    new.path := new.name;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
    if new.parent_id = new.id or exists (
      with recursive ancestors (id, parent_id, depth) as (
        select l.id, l.parent_id, 1 from public.location l where l.id = new.parent_id
        union all
        select l.id, l.parent_id, a.depth + 1
          from public.location l join ancestors a on l.id = a.parent_id
         where a.depth < 64
      )
      select 1 from ancestors where id = new.id
    ) then
      raise exception 'a place cannot be moved inside itself' using errcode = '23514';
    end if;
  end if;

  select l.path into v_parent_path
    from public.location l
   where l.id = new.parent_id and l.household_id = new.household_id;
  -- Parent not visible (other household): the composite FK rejects the row after this trigger.
  new.path := coalesce(v_parent_path || ' › ', '') || new.name;
  return new;
end;
$$;

-- A renamed or moved place re-paths its children; each child's update re-fires this for its own
-- children. SECURITY DEFINER because clients have no UPDATE privilege on `path`.
create function private.location_cascade_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.location c
     set path = new.path || ' › ' || c.name
   where c.parent_id = new.id
     and c.household_id = new.household_id;
  return null;
end;
$$;

create trigger location_assign_code
  before insert on public.location
  for each row execute function private.location_assign_code();

create trigger location_set_path
  before insert or update of name, parent_id on public.location
  for each row execute function private.location_set_path();

-- Not `update of path`: a rename only lists `name` in its SET, the path changes in the BEFORE trigger.
create trigger location_cascade_path
  after update on public.location
  for each row when (old.path is distinct from new.path)
  execute function private.location_cascade_path();

create trigger location_updated_at
  before update on public.location
  for each row execute function private.set_updated_at();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.location enable row level security;

revoke all on table public.location from anon, authenticated;
grant select, delete on table public.location to authenticated;
-- Column privileges: code, path, household moves and authorship are never client-writable.
-- `id` may be chosen by the client so a photo can be uploaded under the new place's folder.
grant insert (id, household_id, parent_id, name, kind, climate, notes, sort, map_x, map_y)
  on table public.location to authenticated;
grant update (parent_id, name, kind, climate, notes, sort, map_x, map_y)
  on table public.location to authenticated;

create policy location_select on public.location
  for select to authenticated
  using (private.is_member(household_id));

create policy location_insert on public.location
  for insert to authenticated
  with check (private.can_write(household_id));

create policy location_update on public.location
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy location_delete on public.location
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '8' where key = 'schema_version';
