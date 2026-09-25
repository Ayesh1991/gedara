-- Phase 5 · 33 — assets (MASTER_PLAN §3.5): the Things module, one row per physical object
-- (qty allowed for identical sets like 6 chairs). Every asset gets an immutable HL:AST label code
-- (random, like places and products) and a human tag A-0042 (`asset_no`, per household, never
-- reused). An asset bought on a bill points at that bill's line (`transaction_line_id`, §1 "every
-- physical thing points back to the line that bought it"); price, date and shop are copied from the
-- bill when not typed in, so deleting the bill later only removes the link.
--
-- Error codes the app maps to messages:
--   GDLIN  this bill line isn't a Things line (or not a purchase)
--   GDSLD  sold status is set / cleared only by selling / undoing the sale

create table public.asset (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references public.household (id) on delete cascade,
  asset_no            integer not null check (asset_no > 0),
  code                text not null unique check (code ~ '^HL:AST:[0-9A-HJKMNP-TV-Z]{6}$'),
  name                text not null check (length(btrim(name)) between 1 and 80),
  description         text check (length(description) <= 2000),
  category_id         uuid,
  location_id         uuid,
  parent_id           uuid,                                    -- laptop › charger, car › spare wheel
  quantity            integer not null default 1 check (quantity between 1 and 10000),
  manufacturer        text check (length(manufacturer) <= 80),
  model_no            text check (length(model_no) <= 80),
  serial_no           text check (length(serial_no) <= 120),
  condition           text check (condition in ('new', 'good', 'fair', 'poor', 'broken')),
  status              text not null default 'in_use'
                        check (status in ('in_use', 'stored', 'lent', 'in_repair', 'sold', 'disposed', 'lost')),
  lent_to             text check (length(lent_to) <= 80),
  lent_on             date,
  -- money links
  transaction_line_id uuid,                                    -- the bill line that bought it
  purchase_price      numeric(14,2) check (purchase_price >= 0),
  purchased_on        date,
  vendor              text check (length(vendor) <= 120),
  useful_life_months  integer check (useful_life_months between 1 and 1200),  -- straight-line depreciation
  salvage_value       numeric(14,2) check (salvage_value >= 0),
  warranty_until      date,
  lifetime_warranty   boolean not null default false,
  warranty_notes      text check (length(warranty_notes) <= 500),
  insured             boolean not null default false,
  insurance_notes     text check (length(insurance_notes) <= 500),
  sold_on             date,
  sold_to             text check (length(sold_to) <= 120),
  sold_price          numeric(14,2) check (sold_price >= 0),
  sale_transaction_id uuid,
  custom              jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 8192),
  archived            boolean not null default false,
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, asset_no),
  -- Same-household references. NO ACTION on category (archive instead) and place (a place with
  -- things inside can't be deleted, as with stock); parts, bill lines and sales just lose the link.
  foreign key (household_id, category_id) references public.category (household_id, id),
  foreign key (household_id, location_id) references public.location (household_id, id),
  foreign key (household_id, parent_id) references public.asset (household_id, id)
    on delete set null (parent_id),
  foreign key (household_id, transaction_line_id) references public.transaction_line (household_id, id)
    on delete set null (transaction_line_id),
  foreign key (household_id, sale_transaction_id) references public.money_transaction (household_id, id)
    on delete set null (sale_transaction_id)
);

create index asset_category_idx on public.asset (household_id, category_id);
create index asset_location_idx on public.asset (household_id, location_id);
create index asset_parent_idx on public.asset (household_id, parent_id) where parent_id is not null;
create index asset_line_idx on public.asset (household_id, transaction_line_id) where transaction_line_id is not null;
create index asset_sale_idx on public.asset (household_id, sale_transaction_id) where sale_transaction_id is not null;
create index asset_created_by_idx on public.asset (created_by);

-- The last A-number per household, so a deleted asset's number is never handed out again (its
-- printed label text would otherwise name a different thing). Only the trigger below touches it.
create table private.asset_no_counter (
  household_id uuid primary key references public.household (id) on delete cascade,
  last_no      integer not null
);
alter table private.asset_no_counter enable row level security;
revoke all on table private.asset_no_counter from public, anon, authenticated;

-- ── Triggers ──────────────────────────────────────────────────────────────────

-- Code and A-number are assigned here, never by the client (column privileges don't allow it).
create function private.asset_assign_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.code := private.new_hl_code('AST', 'public.asset'::regclass);
  insert into private.asset_no_counter as c (household_id, last_no)
  values (new.household_id, 1)
  on conflict (household_id) do update set last_no = c.last_no + 1
  returning c.last_no into new.asset_no;
  return new;
end;
$$;

-- Tidy text; parts can't contain themselves; lent needs a name; sold only through the sale RPCs;
-- a bill link must be a Things purchase line, and fills price / date / shop that weren't typed.
create function private.asset_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_line public.transaction_line%rowtype;
  v_tx   public.money_transaction%rowtype;
begin
  new.name := btrim(new.name);
  new.description := nullif(btrim(new.description), '');
  new.manufacturer := nullif(btrim(new.manufacturer), '');
  new.model_no := nullif(btrim(new.model_no), '');
  new.serial_no := nullif(btrim(new.serial_no), '');
  new.vendor := nullif(btrim(new.vendor), '');
  new.lent_to := nullif(btrim(new.lent_to), '');
  new.warranty_notes := nullif(btrim(new.warranty_notes), '');
  new.insurance_notes := nullif(btrim(new.insurance_notes), '');

  -- Parts
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id or exists (
      with recursive ancestors (id, parent_id, depth) as (
        select a.id, a.parent_id, 1 from public.asset a where a.id = new.parent_id
        union all
        select a.id, a.parent_id, s.depth + 1
          from public.asset a join ancestors s on a.id = s.parent_id
         where s.depth < 64
      )
      select 1 from ancestors where id = new.id
    ) then
      raise exception 'a thing cannot be a part of itself' using errcode = '23514';
    end if;
  end if;

  -- Sold: only the sale RPCs set / clear the sale link, and the status follows it.
  if new.status = 'sold' and new.sale_transaction_id is null
     and (tg_op = 'INSERT' or old.status <> 'sold') then
    raise exception 'use Sell to mark a thing as sold' using errcode = 'GDSLD';
  end if;
  if tg_op = 'UPDATE' and old.status = 'sold' and new.status <> 'sold' and new.sale_transaction_id is not null then
    raise exception 'undo the sale to bring this thing back' using errcode = 'GDSLD';
  end if;
  if new.status <> 'sold' then
    new.sold_on := null;
    new.sold_to := null;
    new.sold_price := null;
  end if;

  -- Lent: to whom is required; back home clears it.
  if new.status = 'lent' then
    if new.lent_to is null then
      raise exception 'say who it is lent to' using errcode = '23514';
    end if;
    new.lent_on := coalesce(new.lent_on, current_date);
  else
    new.lent_to := null;
    new.lent_on := null;
  end if;

  -- Bill link
  if new.transaction_line_id is not null
     and (tg_op = 'INSERT' or new.transaction_line_id is distinct from old.transaction_line_id) then
    select l.* into v_line from public.transaction_line l
     where l.id = new.transaction_line_id and l.household_id = new.household_id;
    if found then
      select t.* into v_tx from public.money_transaction t where t.id = v_line.transaction_id;
      if v_line.destiny is distinct from 'asset' or v_tx.type <> 'expense' or v_line.amount <= 0 then
        raise exception 'bill line % is not a Things purchase', v_line.line_no using errcode = 'GDLIN';
      end if;
      new.purchased_on := coalesce(new.purchased_on, v_tx.occurred_on);
      new.vendor := coalesce(new.vendor, v_tx.payee_text);
      new.purchase_price := coalesce(new.purchase_price,
        least(v_line.amount, round(v_line.amount / greatest(coalesce(v_line.qty, 1), 1) * new.quantity, 2)));
    end if;
    -- Not visible (other household): the composite FK rejects the row after this trigger.
  end if;
  return new;
end;
$$;

create trigger asset_assign_code
  before insert on public.asset
  for each row execute function private.asset_assign_code();

create trigger asset_check
  before insert or update on public.asset
  for each row execute function private.asset_check();

create trigger asset_updated_at
  before update on public.asset
  for each row execute function private.set_updated_at();

-- An asset's photos and documents go when it goes (the client removes the files, best effort).
create function private.asset_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'asset' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger asset_delete_attachments
  after delete on public.asset
  for each row execute function private.asset_delete_attachments();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.asset enable row level security;

revoke all on table public.asset from anon, authenticated;
grant select, delete on table public.asset to authenticated;
-- `code`, `asset_no`, the sale columns and authorship are never client-writable. `id` may be chosen
-- by the client so a photo can be uploaded under the new asset's folder (same as places/products).
grant insert (id, household_id, name, description, category_id, location_id, parent_id, quantity,
              manufacturer, model_no, serial_no, condition, status, lent_to, lent_on, transaction_line_id,
              purchase_price, purchased_on, vendor, useful_life_months, salvage_value, warranty_until,
              lifetime_warranty, warranty_notes, insured, insurance_notes, custom)
  on table public.asset to authenticated;
grant update (name, description, category_id, location_id, parent_id, quantity, manufacturer, model_no,
              serial_no, condition, status, lent_to, lent_on, transaction_line_id, purchase_price,
              purchased_on, vendor, useful_life_months, salvage_value, warranty_until, lifetime_warranty,
              warranty_notes, insured, insurance_notes, custom, archived)
  on table public.asset to authenticated;

create policy asset_select on public.asset
  for select to authenticated
  using (private.is_member(household_id));

create policy asset_insert on public.asset
  for insert to authenticated
  with check (private.can_write(household_id));

create policy asset_update on public.asset
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy asset_delete on public.asset
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '33' where key = 'schema_version';
