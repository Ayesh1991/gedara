-- Phase 3 · 24 — barcodes + product unit conversions (MASTER_PLAN §3.2, §3.4)
-- A barcode says what one scan means: 4792024000222 = 1 pack of Nescafé (= 50 g via the
-- conversion). A barcode belongs to exactly one product per household, so a scan is never
-- ambiguous. Conversions turn purchase units into the stock unit: "1 pack = 400 g".
-- Changing a conversion never changes existing stock: lots are stored in stock units.

create table public.product_barcode (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  product_id   uuid not null,
  barcode      text not null check (barcode ~ '^[0-9A-Za-z._-]{4,64}$'),
  unit_id      uuid references public.unit (id),        -- null = the product's stock unit
  qty          numeric(14,4) not null default 1 check (qty > 0),
  merchant_id  uuid,
  note         text check (length(note) <= 200),
  created_at   timestamptz not null default now(),
  unique (household_id, barcode),
  foreign key (household_id, product_id) references public.product (household_id, id) on delete cascade,
  foreign key (household_id, merchant_id) references public.merchant (household_id, id)
    on delete set null (merchant_id)
);

create index product_barcode_product_idx on public.product_barcode (household_id, product_id);
create index product_barcode_unit_idx on public.product_barcode (unit_id) where unit_id is not null;
create index product_barcode_merchant_idx on public.product_barcode (household_id, merchant_id)
  where merchant_id is not null;

create table public.product_unit_conversion (
  household_id uuid not null references public.household (id) on delete cascade,
  product_id   uuid not null,
  from_unit_id uuid not null references public.unit (id),
  to_unit_id   uuid not null references public.unit (id),
  factor       numeric(14,6) not null check (factor > 0),   -- 1 from_unit = factor × to_unit
  created_at   timestamptz not null default now(),
  primary key (product_id, from_unit_id),
  check (from_unit_id <> to_unit_id),
  foreign key (household_id, product_id) references public.product (household_id, id) on delete cascade
);

create index product_unit_conversion_household_idx on public.product_unit_conversion (household_id, product_id);
create index product_unit_conversion_from_idx on public.product_unit_conversion (from_unit_id);
create index product_unit_conversion_to_idx on public.product_unit_conversion (to_unit_id);

-- Units must be system units or the household's own.
create function private.barcode_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.barcode := btrim(new.barcode);
  new.note := nullif(btrim(new.note), '');
  if not private.unit_usable(new.unit_id, new.household_id) then
    raise exception 'unknown unit' using errcode = '23503';
  end if;
  return new;
end;
$$;

create function private.conversion_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.unit_usable(new.from_unit_id, new.household_id)
     or not private.unit_usable(new.to_unit_id, new.household_id) then
    raise exception 'unknown unit' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger product_barcode_check
  before insert or update on public.product_barcode
  for each row execute function private.barcode_check();

create trigger product_unit_conversion_check
  before insert or update on public.product_unit_conversion
  for each row execute function private.conversion_check();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.product_barcode enable row level security;
alter table public.product_unit_conversion enable row level security;

revoke all on table public.product_barcode from anon, authenticated;
revoke all on table public.product_unit_conversion from anon, authenticated;
grant select, delete on table public.product_barcode to authenticated;
grant insert (household_id, product_id, barcode, unit_id, qty, merchant_id, note)
  on table public.product_barcode to authenticated;
grant update (unit_id, qty, merchant_id, note) on table public.product_barcode to authenticated;
grant select, delete on table public.product_unit_conversion to authenticated;
grant insert (household_id, product_id, from_unit_id, to_unit_id, factor)
  on table public.product_unit_conversion to authenticated;
grant update (to_unit_id, factor) on table public.product_unit_conversion to authenticated;

create policy product_barcode_select on public.product_barcode
  for select to authenticated
  using (private.is_member(household_id));
create policy product_barcode_insert on public.product_barcode
  for insert to authenticated
  with check (private.can_write(household_id));
create policy product_barcode_update on public.product_barcode
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));
create policy product_barcode_delete on public.product_barcode
  for delete to authenticated
  using (private.can_write(household_id));

create policy product_unit_conversion_select on public.product_unit_conversion
  for select to authenticated
  using (private.is_member(household_id));
create policy product_unit_conversion_insert on public.product_unit_conversion
  for insert to authenticated
  with check (private.can_write(household_id));
create policy product_unit_conversion_update on public.product_unit_conversion
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));
create policy product_unit_conversion_delete on public.product_unit_conversion
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '24' where key = 'schema_version';
