-- Phase 7b · 56 — blank label sheets: print first, assign later (MASTER_PLAN §3.8, §7c)
-- A sheet of brand-new HL:TAG codes is printed before anything exists; a label is stuck on a box /
-- jar / thing and the first scan says what it is. From then on the code opens that place, thing or
-- product (next to the item's own HL:LOC / HL:AST / HL:PRD code — an item may carry several labels).
--
-- Printed labels are permanent, so:
--   · codes come from the database (unique across every household, like all HL codes) and never
--     change; sheets are numbered per household by a counter that never goes back;
--   · sheets and codes are never deleted by clients (no DELETE privilege), so a code is never handed
--     out twice — not even after its label was thrown away (retired);
--   · "detach" empties a label so the SAME sticker can be assigned again; "retired" is final.
-- Clients only read these tables; every write goes through the RPCs of migration 57.

create table public.label_sheet (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.household (id) on delete cascade,
  sheet_no        integer not null check (sheet_no > 0),
  -- a4 = Epson 6 × 9 URL QR · a4mini = 10 mm raw-code QR on A4 · sq20 / sq10 = NIIMBOT batch
  format          text not null check (format in ('a4', 'a4mini', 'sq20', 'sq10')),
  slots           integer not null check (slots between 1 and 300),
  print_count     integer not null default 0 check (print_count >= 0),
  last_printed_at timestamptz,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, sheet_no)
);

create index label_sheet_created_by_idx on public.label_sheet (created_by);

-- The last sheet number per household ("Sheet 7"), never reused. Only rpc_label_sheets touches it.
create table private.label_sheet_counter (
  household_id uuid primary key references public.household (id) on delete cascade,
  last_no      integer not null
);
alter table private.label_sheet_counter enable row level security;
revoke all on table private.label_sheet_counter from public, anon, authenticated;

create table public.label_tag (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  sheet_id     uuid not null,
  slot         integer not null check (slot between 0 and 299),   -- position on the sheet, row by row
  code         text not null unique check (code ~ '^HL:TAG:[0-9A-HJKMNP-TV-Z]{6}$'),
  -- What the label means (at most one). Deleting the item makes the label blank again.
  location_id  uuid,
  asset_id     uuid,
  product_id   uuid,
  assigned_at  timestamptz,
  assigned_by  uuid references auth.users (id) on delete set null,
  retired_at   timestamptz,                                          -- thrown away / lost: final
  created_at   timestamptz not null default now(),
  unique (sheet_id, slot),
  foreign key (household_id, sheet_id) references public.label_sheet (household_id, id) on delete cascade,
  foreign key (household_id, location_id) references public.location (household_id, id)
    on delete set null (location_id),
  foreign key (household_id, asset_id) references public.asset (household_id, id)
    on delete set null (asset_id),
  foreign key (household_id, product_id) references public.product (household_id, id)
    on delete set null (product_id),
  check (num_nonnulls(location_id, asset_id, product_id) <= 1),
  check (retired_at is null or num_nonnulls(location_id, asset_id, product_id) = 0)
);

create index label_tag_location_idx on public.label_tag (household_id, location_id) where location_id is not null;
create index label_tag_asset_idx on public.label_tag (household_id, asset_id) where asset_id is not null;
create index label_tag_product_idx on public.label_tag (household_id, product_id) where product_id is not null;
create index label_tag_assigned_by_idx on public.label_tag (assigned_by);

-- Belt and braces for the "printed labels are permanent" rules, whoever writes (RPCs included):
-- a label never changes code, sheet, slot or household, and a retired label stays retired and empty.
create function private.label_tag_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code is distinct from old.code or new.sheet_id is distinct from old.sheet_id
     or new.slot is distinct from old.slot or new.household_id is distinct from old.household_id then
    raise exception 'a printed label never changes its code or sheet' using errcode = '23514';
  end if;
  if old.retired_at is not null
     and (new.retired_at is distinct from old.retired_at
          or num_nonnulls(new.location_id, new.asset_id, new.product_id) > 0) then
    raise exception 'this label was retired' using errcode = 'GDTAG', detail = 'retired';
  end if;
  return new;
end;
$$;

create trigger label_tag_guard
  before update on public.label_tag
  for each row execute function private.label_tag_guard();

revoke execute on function private.label_tag_guard() from public, anon, authenticated;

-- ── RLS + privileges: read-only to clients ────────────────────────────────────
alter table public.label_sheet enable row level security;
alter table public.label_tag enable row level security;

revoke all on table public.label_sheet from anon, authenticated;
revoke all on table public.label_tag from anon, authenticated;
grant select on table public.label_sheet to authenticated;
grant select on table public.label_tag to authenticated;

create policy label_sheet_select on public.label_sheet
  for select to authenticated
  using (private.is_member(household_id));

create policy label_tag_select on public.label_tag
  for select to authenticated
  using (private.is_member(household_id));

update public.app_meta set value = '56' where key = 'schema_version';
