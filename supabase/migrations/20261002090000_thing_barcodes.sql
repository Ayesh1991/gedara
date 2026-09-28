-- Phase 7e · 61 — Things carry retail barcodes; a product that is really a Thing moves to Things
-- Didula's books (ISBN on the back) were saved as Pantry products because an unknown barcode only
-- offered "New product" and a Thing couldn't hold a barcode. A book isn't stock you use up: it is
-- kept, lent and moved, like any Thing. From now on Things have barcodes (several copies of a book
-- share one ISBN, so a barcode may belong to more than one Thing), and rpc_product_to_thing moves a
-- product — with its barcodes, extra QR labels and photo — into Things in one transaction.
--
-- Error codes the app maps to messages:
--   GDSTK  there is still stock (use it up or count it first)
--   GDUSE  some of its stock came from a bill (real spending: it stays in Pantry)
--   GDVAR  it has variants under it

create table public.asset_barcode (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  asset_id     uuid not null,
  barcode      text not null check (barcode ~ '^[0-9A-Za-z._-]{4,64}$'),
  created_at   timestamptz not null default now(),
  unique (household_id, asset_id, barcode),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete cascade
);

create index asset_barcode_barcode_idx on public.asset_barcode (household_id, barcode);

alter table public.asset_barcode enable row level security;

revoke all on table public.asset_barcode from anon, authenticated;
grant select, delete on table public.asset_barcode to authenticated;
grant insert (household_id, asset_id, barcode) on table public.asset_barcode to authenticated;

create policy asset_barcode_select on public.asset_barcode
  for select to authenticated
  using (private.is_member(household_id));

create policy asset_barcode_insert on public.asset_barcode
  for insert to authenticated
  with check (private.can_write(household_id));

create policy asset_barcode_delete on public.asset_barcode
  for delete to authenticated
  using (private.can_write(household_id));

-- ── A product that is really a Thing → a Thing ──────────────────────────────────
-- Returns the new thing's id. The product's own HL:PRD code goes with it (it never opened a
-- Thing); its extra QR labels (HL:TAG) now open the Thing.
create function public.rpc_product_to_thing(p_product uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v       public.product%rowtype;
  v_asset uuid := gen_random_uuid();
begin
  select * into v from public.product p where p.id = p_product for update;
  if not found or not private.is_member(v.household_id) then
    raise exception 'unknown product' using errcode = '23503';
  end if;
  if not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.product c where c.parent_id = v.id and c.household_id = v.household_id) then
    raise exception 'it has variants' using errcode = 'GDVAR';
  end if;
  if exists (select 1 from public.stock_lot l where l.product_id = v.id and l.qty_remaining > 0) then
    raise exception 'there is still stock' using errcode = 'GDSTK';
  end if;
  if exists (select 1 from public.stock_lot l where l.product_id = v.id and l.transaction_line_id is not null) then
    raise exception 'some of it was bought on a bill' using errcode = 'GDUSE';
  end if;

  insert into public.asset (id, household_id, name, description, category_id, location_id, quantity)
  values (v_asset, v.household_id, v.name, nullif(btrim(v.notes), ''), v.category_id, v.default_location_id, 1);

  insert into public.asset_barcode (household_id, asset_id, barcode)
  select v.household_id, v_asset, b.barcode from public.product_barcode b where b.product_id = v.id
  on conflict do nothing;

  update public.label_tag t set product_id = null, asset_id = v_asset
   where t.product_id = v.id and t.household_id = v.household_id;

  update public.attachment a set entity_type = 'asset', entity_id = v_asset
   where a.entity_type = 'product' and a.entity_id = v.id and a.household_id = v.household_id;

  -- The empty stock history (nothing left, no bill): an accidental add / use.
  delete from public.stock_movement m where m.product_id = v.id and m.household_id = v.household_id;
  delete from public.stock_lot l where l.product_id = v.id and l.household_id = v.household_id;

  -- Barcodes, conversions, learned bill names and list items go with the product (cascades).
  delete from public.product p where p.id = v.id;
  return v_asset;
end;
$$;

-- A sub-category added in the app (Settings › Categories, "+ New category…") takes where its main
-- category's purchases go (Books under Non-consumables → Things). The app never sets a destiny on
-- insert, so the column default 'expense' meant "not chosen" and sent new book lines to expenses.
create function private.category_inherit_destiny()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is not null and new.default_destiny = 'expense' then
    select p.default_destiny into new.default_destiny
      from public.category p
     where p.id = new.parent_id and p.household_id = new.household_id;
    new.default_destiny := coalesce(new.default_destiny, 'expense');
  end if;
  return new;
end;
$$;

create trigger category_inherit_destiny
  before insert on public.category
  for each row execute function private.category_inherit_destiny();

revoke execute on function private.category_inherit_destiny() from public, anon, authenticated;

revoke execute on function public.rpc_product_to_thing(uuid) from public, anon;
grant execute on function public.rpc_product_to_thing(uuid) to authenticated;

update public.app_meta set value = '61' where key = 'schema_version';
