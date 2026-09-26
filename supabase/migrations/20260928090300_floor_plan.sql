-- Phase 7 · 53 — Places floor plan (MASTER_PLAN §5.2, moved here from Phase 6)
-- One floor plan per floor: a photo or sketch (stored like every other picture, as the plan's
-- primary `attachment`, entity_type 'floor_plan') with places pinned on it. A pin is the place's
-- `floor_plan_id` + `map_x / map_y`, fractions 0–1 of the image's width / height, so pins stay put
-- whatever size the screen draws the image at.

create table public.floor_plan (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 60),
  sort         integer not null default 0,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, id)
);

create index floor_plan_household_idx on public.floor_plan (household_id, sort);
create index floor_plan_created_by_idx on public.floor_plan (created_by);

create trigger floor_plan_updated_at
  before update on public.floor_plan
  for each row execute function private.set_updated_at();

-- Deleting a plan removes its picture rows (the client removes the files, best effort).
create function private.floor_plan_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'floor_plan' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger floor_plan_delete_attachments
  after delete on public.floor_plan
  for each row execute function private.floor_plan_delete_attachments();

revoke execute on function private.floor_plan_delete_attachments() from public, anon, authenticated;

alter table public.floor_plan enable row level security;

revoke all on table public.floor_plan from anon, authenticated;
grant select, delete on table public.floor_plan to authenticated;
grant insert (id, household_id, name, sort) on table public.floor_plan to authenticated;
grant update (name, sort) on table public.floor_plan to authenticated;

create policy floor_plan_select on public.floor_plan for select to authenticated
  using (private.is_member(household_id));
create policy floor_plan_insert on public.floor_plan for insert to authenticated
  with check (private.can_write(household_id));
create policy floor_plan_update on public.floor_plan for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy floor_plan_delete on public.floor_plan for delete to authenticated
  using (private.can_write(household_id));

-- ── Pins ──────────────────────────────────────────────────────────────────────
alter table public.location
  add column floor_plan_id uuid,
  add constraint location_floor_plan_fk foreign key (household_id, floor_plan_id)
    references public.floor_plan (household_id, id) on delete set null (floor_plan_id),
  add constraint location_map_range check ((map_x is null or map_x between 0 and 1)
                                       and (map_y is null or map_y between 0 and 1));

create index location_floor_plan_idx on public.location (household_id, floor_plan_id) where floor_plan_id is not null;

grant insert (floor_plan_id) on table public.location to authenticated;
grant update (floor_plan_id) on table public.location to authenticated;

-- ── The plan's picture lives in `attachment` ─────────────────────────────────
alter table public.attachment drop constraint attachment_entity_type_check;
alter table public.attachment add constraint attachment_entity_type_check
  check (entity_type in ('product', 'lot', 'asset', 'location', 'transaction', 'maintenance', 'floor_plan'));

update public.app_meta set value = '53' where key = 'schema_version';
