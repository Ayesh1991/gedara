-- Phase 1 · 10 — A4 label sheet profile per printer (MASTER_PLAN §7c)
-- Grid, margins and the calibration offsets measured with the calibration page. Inkjet feed offsets
-- are a property of the printer, so they're shared by the household. The app's defaults
-- (Epson L3110, 6 × 9 landscape, no margins) apply until a profile is saved.

create table public.label_profile (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  template      text not null default 'a4-grid' check (template in ('a4-grid')),
  orientation   text not null default 'landscape' check (orientation in ('landscape', 'portrait')),
  rows          integer not null default 6 check (rows between 1 and 30),
  cols          integer not null default 9 check (cols between 1 and 30),
  margin_top    numeric(5,2) not null default 0 check (margin_top between 0 and 60),
  margin_right  numeric(5,2) not null default 0 check (margin_right between 0 and 60),
  margin_bottom numeric(5,2) not null default 0 check (margin_bottom between 0 and 60),
  margin_left   numeric(5,2) not null default 0 check (margin_left between 0 and 60),
  gutter_x      numeric(5,2) not null default 0 check (gutter_x between 0 and 30),
  gutter_y      numeric(5,2) not null default 0 check (gutter_y between 0 and 30),
  offset_x      numeric(5,2) not null default 0 check (offset_x between -20 and 20),
  offset_y      numeric(5,2) not null default 0 check (offset_y between -20 and 20),
  qr_mm         numeric(5,2) not null default 24 check (qr_mm between 8 and 60),
  updated_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, name)
);

create index label_profile_updated_by_idx on public.label_profile (updated_by);

create trigger label_profile_updated_at
  before update on public.label_profile
  for each row execute function private.set_updated_at();

alter table public.label_profile enable row level security;

revoke all on table public.label_profile from anon, authenticated;
grant select, delete on table public.label_profile to authenticated;
grant insert (household_id, name, template, orientation, rows, cols, margin_top, margin_right,
              margin_bottom, margin_left, gutter_x, gutter_y, offset_x, offset_y, qr_mm)
  on table public.label_profile to authenticated;
grant update (name, orientation, rows, cols, margin_top, margin_right, margin_bottom, margin_left,
              gutter_x, gutter_y, offset_x, offset_y, qr_mm)
  on table public.label_profile to authenticated;

create policy label_profile_select on public.label_profile
  for select to authenticated
  using (private.is_member(household_id));

create policy label_profile_insert on public.label_profile
  for insert to authenticated
  with check (private.can_write(household_id));

create policy label_profile_update on public.label_profile
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy label_profile_delete on public.label_profile
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '10' where key = 'schema_version';
