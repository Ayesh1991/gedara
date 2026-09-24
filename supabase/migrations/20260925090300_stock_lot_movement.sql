-- Phase 3 · 25 — stock lots + the stock journal (MASTER_PLAN §3.4, CLAUDE.md rule 1)
-- A lot is one batch: "the 1 kg sugar bought on 20 Sep, best before March". Its quantity is never
-- written directly: `qty_remaining` is only changed by the trigger below, when a `stock_movement`
-- row is appended, and movements are only written by the SECURITY DEFINER RPCs of migration 26.
-- So at all times: lot.qty_remaining = Σ movement.delta for that lot.
-- Quantities and costs are in the product's stock unit (unit_cost = Rs per g / ml / pcs).

-- Lots can point at the bill line that bought them (Phase 4 fills this in).
alter table public.transaction_line add constraint transaction_line_household_id_key unique (household_id, id);

create table public.stock_lot (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references public.household (id) on delete cascade,
  product_id          uuid not null,
  location_id         uuid,
  qty_initial         numeric(14,4) not null check (qty_initial >= 0),
  qty_remaining       numeric(14,4) not null default 0 check (qty_remaining >= 0),
  unit_cost           numeric(14,4) check (unit_cost >= 0),
  purchased_on        date,
  due_date            date,
  opened_at           timestamptz,
  transaction_line_id uuid,
  split_from_id       uuid,
  note                text check (length(note) <= 500),
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  status              text generated always as (case when qty_remaining > 0 then 'active' else 'empty' end) stored,
  unique (household_id, id),
  -- NO ACTION: a product with stock history can't be deleted (archive it).
  foreign key (household_id, product_id) references public.product (household_id, id),
  foreign key (household_id, location_id) references public.location (household_id, id)
    on delete set null (location_id),
  foreign key (household_id, transaction_line_id) references public.transaction_line (household_id, id)
    on delete set null (transaction_line_id),
  foreign key (household_id, split_from_id) references public.stock_lot (household_id, id)
);

create index stock_lot_product_active_idx on public.stock_lot (household_id, product_id) where qty_remaining > 0;
create index stock_lot_product_idx on public.stock_lot (household_id, product_id);
create index stock_lot_location_idx on public.stock_lot (household_id, location_id);
create index stock_lot_line_idx on public.stock_lot (household_id, transaction_line_id) where transaction_line_id is not null;
create index stock_lot_split_idx on public.stock_lot (household_id, split_from_id) where split_from_id is not null;
create index stock_lot_created_by_idx on public.stock_lot (created_by);

create table public.stock_movement (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,     -- total order ("did anything happen since?")
  household_id   uuid not null references public.household (id) on delete cascade,
  lot_id         uuid not null,
  product_id     uuid not null,
  delta          numeric(14,4) not null,                  -- in the product's stock unit
  reason         text not null check (reason in
                   ('purchase', 'consume', 'waste', 'open', 'transfer_out', 'transfer_in', 'adjust', 'edit', 'undo')),
  location_id    uuid,                                    -- where the lot was (or went to, for transfer_in)
  unit_cost      numeric(14,4),                           -- Rs per stock unit at the time
  correlation_id uuid not null,                           -- one user action = one correlation (undo unit)
  reverses_id    uuid,                                    -- set on 'undo' rows
  meta           jsonb check (meta is null or jsonb_typeof(meta) = 'object'),  -- lot state before/after
  note           text check (length(note) <= 500),
  actor          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, lot_id) references public.stock_lot (household_id, id),
  foreign key (household_id, product_id) references public.product (household_id, id),
  foreign key (household_id, location_id) references public.location (household_id, id)
    on delete set null (location_id),
  foreign key (household_id, reverses_id) references public.stock_movement (household_id, id),
  check ((reason = 'undo') = (reverses_id is not null)),
  check (delta <> 0 or reason in ('open', 'edit', 'undo'))
);

-- A movement can be undone once.
create unique index stock_movement_reverses_idx on public.stock_movement (reverses_id) where reverses_id is not null;
create index stock_movement_journal_idx on public.stock_movement (household_id, seq desc);
create index stock_movement_product_idx on public.stock_movement (household_id, product_id, seq desc);
create index stock_movement_lot_idx on public.stock_movement (lot_id, seq);
create index stock_movement_correlation_idx on public.stock_movement (household_id, correlation_id);
create index stock_movement_location_idx on public.stock_movement (household_id, location_id) where location_id is not null;
create index stock_movement_actor_idx on public.stock_movement (actor);

-- ── Triggers ──────────────────────────────────────────────────────────────────

-- The only writer of qty_remaining. The lot's check (>= 0) rejects anything that would go negative.
create function private.stock_movement_apply()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.delta <> 0 then
    update public.stock_lot l
       set qty_remaining = l.qty_remaining + new.delta
     where l.id = new.lot_id and l.household_id = new.household_id;
  end if;
  return null;
end;
$$;

create trigger stock_movement_apply
  after insert on public.stock_movement
  for each row execute function private.stock_movement_apply();

-- Belt and braces for rule 1: even a SECURITY DEFINER bug can't rewrite journal rows. The one
-- allowed change is the foreign key clearing `location_id` when a (now empty) place is deleted.
create function private.stock_movement_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_id is null and (to_jsonb(new) - 'location_id') = (to_jsonb(old) - 'location_id') then
    return new;
  end if;
  raise exception 'the stock journal is append-only' using errcode = '42501';
end;
$$;

create trigger stock_movement_no_update
  before update on public.stock_movement
  for each row execute function private.stock_movement_immutable();

create trigger stock_lot_updated_at
  before update on public.stock_lot
  for each row execute function private.set_updated_at();

-- A product's stock unit is fixed once it has stock history (every lot is counted in it).
create function private.product_lock_stock_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stock_unit_id is distinct from old.stock_unit_id
     and exists (select 1 from public.stock_lot l where l.product_id = old.id) then
    raise exception 'the stock unit can''t change once the product has stock history' using errcode = 'GDUNL';
  end if;
  return new;
end;
$$;

create trigger product_lock_stock_unit
  before update of stock_unit_id on public.product
  for each row execute function private.product_lock_stock_unit();

-- A place can't be deleted while it holds stock (empty lots just lose their place).
create function private.location_refuse_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.stock_lot l where l.location_id = old.id and l.qty_remaining > 0) then
    raise exception 'this place still holds stock' using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger location_refuse_stock
  before delete on public.location
  for each row execute function private.location_refuse_stock();

-- ── RLS + privileges: read-only to clients (rule 1) ───────────────────────────
alter table public.stock_lot enable row level security;
alter table public.stock_movement enable row level security;

revoke all on table public.stock_lot from anon, authenticated;
revoke all on table public.stock_movement from anon, authenticated;
grant select on table public.stock_lot to authenticated;
grant select on table public.stock_movement to authenticated;

create policy stock_lot_select on public.stock_lot
  for select to authenticated
  using (private.is_member(household_id));

create policy stock_movement_select on public.stock_movement
  for select to authenticated
  using (private.is_member(household_id));

update public.app_meta set value = '25' where key = 'schema_version';
