-- Phase 3 · 23 — products (MASTER_PLAN §3.4): what the pantry counts
-- A product is counted in its `stock_unit` (g for loose spices, pcs for eggs); every quantity and
-- price in the stock tables is in that unit. Every product gets an immutable HL:PRD label code so
-- loose goods and jars without an EAN can be scanned too.

create table public.product (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references public.household (id) on delete cascade,
  name                text not null check (length(btrim(name)) between 1 and 80),
  name_si             text check (length(name_si) <= 80),            -- Sinhala / Tamil name for search
  parent_id           uuid,                                            -- "Rice" › "Keeri samba"
  category_id         uuid,
  stock_unit_id       uuid not null references public.unit (id),
  purchase_unit_id    uuid references public.unit (id),
  min_qty             numeric(14,4) check (min_qty >= 0),              -- in stock units
  reorder_qty         numeric(14,4) check (reorder_qty > 0),
  default_location_id uuid,
  due_type            text not null default 'none' check (due_type in ('none', 'best_before', 'expiry')),
  default_due_days    integer check (default_due_days between 0 and 3650),
  due_days_after_open integer check (due_days_after_open between 0 and 3650),
  due_days_frozen     integer check (due_days_frozen between 0 and 3650),
  quick_consume_qty   numeric(14,4) not null default 1 check (quick_consume_qty > 0),
  treat_opened_as_out boolean not null default false,
  code                text not null unique check (code ~ '^HL:PRD:[0-9A-HJKMNP-TV-Z]{6}$'),
  attributes          jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  notes               text check (length(notes) <= 2000),
  archived            boolean not null default false,
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (household_id, id),
  -- Same-household references. NO ACTION on the parent and category: archive instead of delete.
  foreign key (household_id, parent_id) references public.product (household_id, id),
  foreign key (household_id, category_id) references public.category (household_id, id),
  foreign key (household_id, default_location_id) references public.location (household_id, id)
    on delete set null (default_location_id)
);

create unique index product_name_idx on public.product (household_id, lower(btrim(name)));
create index product_parent_idx on public.product (household_id, parent_id) where parent_id is not null;
create index product_category_idx on public.product (household_id, category_id);
create index product_location_idx on public.product (household_id, default_location_id);
create index product_stock_unit_idx on public.product (stock_unit_id);
create index product_purchase_unit_idx on public.product (purchase_unit_id) where purchase_unit_id is not null;
create index product_created_by_idx on public.product (created_by);

-- ── Triggers ──────────────────────────────────────────────────────────────────

create function private.product_assign_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.code := private.new_hl_code('PRD', 'public.product'::regclass);
  return new;
end;
$$;

-- Tidy names; units must be system units or this household's; parents are one level deep.
create function private.product_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_grandparent uuid;
begin
  new.name := btrim(new.name);
  new.name_si := nullif(btrim(new.name_si), '');

  if not private.unit_usable(new.stock_unit_id, new.household_id)
     or not private.unit_usable(new.purchase_unit_id, new.household_id) then
    raise exception 'unknown unit' using errcode = '23503';
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a product cannot be its own parent' using errcode = '23514';
    end if;
    select p.parent_id into v_grandparent from public.product p
     where p.id = new.parent_id and p.household_id = new.household_id;
    if v_grandparent is not null then
      raise exception 'a sub-product cannot have sub-products' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from public.product c where c.parent_id = new.id) then
      raise exception 'a product with sub-products must stay top-level' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger product_assign_code
  before insert on public.product
  for each row execute function private.product_assign_code();

create trigger product_check
  before insert or update on public.product
  for each row execute function private.product_check();

create trigger product_updated_at
  before update on public.product
  for each row execute function private.set_updated_at();

-- A product's photos go when it goes (the client removes the files, best effort).
create function private.product_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'product' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger product_delete_attachments
  after delete on public.product
  for each row execute function private.product_delete_attachments();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.product enable row level security;

revoke all on table public.product from anon, authenticated;
grant select, delete on table public.product to authenticated;
-- `code` and authorship are never client-writable. `id` may be chosen by the client so a photo can
-- be uploaded under the new product's folder (same as places).
grant insert (id, household_id, name, name_si, parent_id, category_id, stock_unit_id, purchase_unit_id,
              min_qty, reorder_qty, default_location_id, due_type, default_due_days, due_days_after_open,
              due_days_frozen, quick_consume_qty, treat_opened_as_out, attributes, notes)
  on table public.product to authenticated;
grant update (name, name_si, parent_id, category_id, stock_unit_id, purchase_unit_id, min_qty, reorder_qty,
              default_location_id, due_type, default_due_days, due_days_after_open, due_days_frozen,
              quick_consume_qty, treat_opened_as_out, attributes, notes, archived)
  on table public.product to authenticated;

create policy product_select on public.product
  for select to authenticated
  using (private.is_member(household_id));

create policy product_insert on public.product
  for insert to authenticated
  with check (private.can_write(household_id));

create policy product_update on public.product
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy product_delete on public.product
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '23' where key = 'schema_version';
