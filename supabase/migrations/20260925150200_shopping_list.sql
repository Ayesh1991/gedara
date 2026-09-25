-- Phase 4 · 30 — shopping list (MASTER_PLAN §3.4, §4 rows 1 and 4)
-- Items are a product ("Sugar, 1 kg") or free text ("birthday candles"). Products that fall below
-- their minimum are added by `rpc_shopping_sync` (source 'below_min'); a bill import ticks the open
-- items of the products it stocked (`done_by_line`, migration 31). One list ('Main') for now; the
-- column is there for more later.
-- Members add, edit, tick and remove items directly (RLS); ticking by a bill only happens in the RPCs.

create table public.shopping_list_item (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  list         text not null default 'Main' check (length(btrim(list)) between 1 and 40),
  product_id   uuid,
  free_text    text check (length(btrim(free_text)) between 1 and 120),
  qty          numeric(14,4) check (qty > 0),
  unit_id      uuid references public.unit (id),
  source       text not null default 'manual' check (source in ('manual', 'below_min', 'forecast', 'recipe')),
  note         text check (length(note) <= 200),
  done         boolean not null default false,
  done_at      timestamptz,
  done_by      uuid references auth.users (id) on delete set null,
  done_by_line uuid,                                   -- the bill line that bought it
  dismissed    boolean not null default false,         -- an automatic item the user said "not now" to
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, id),
  check ((product_id is null) <> (free_text is null)),
  check (done or (done_at is null and done_by_line is null)),
  check (not (done and dismissed)),
  foreign key (household_id, product_id) references public.product (household_id, id) on delete cascade,
  foreign key (household_id, done_by_line) references public.transaction_line (household_id, id)
    on delete set null (done_by_line)
);

-- One open item per product per list (adding it again raises the quantity instead).
create unique index shopping_list_item_open_product_idx on public.shopping_list_item (household_id, list, product_id)
  where not done and not dismissed and product_id is not null;
create index shopping_list_item_list_idx on public.shopping_list_item (household_id, list, done);
create index shopping_list_item_product_idx on public.shopping_list_item (household_id, product_id) where product_id is not null;
create index shopping_list_item_line_idx on public.shopping_list_item (household_id, done_by_line) where done_by_line is not null;
create index shopping_list_item_unit_idx on public.shopping_list_item (unit_id) where unit_id is not null;
create index shopping_list_item_created_by_idx on public.shopping_list_item (created_by);
create index shopping_list_item_done_by_idx on public.shopping_list_item (done_by) where done_by is not null;

-- Tidy text, check the unit, stamp who ticked it and when. Editing an automatic item's quantity or
-- note makes it the user's own ('manual'), so the sync no longer removes it.
create function private.shopping_item_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.list := btrim(new.list);
  new.free_text := nullif(btrim(new.free_text), '');
  new.note := nullif(btrim(new.note), '');
  if not private.unit_usable(new.unit_id, new.household_id) then
    raise exception 'unknown unit' using errcode = '23503';
  end if;

  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.done then
    new.done_at := null;
    new.done_by := null;
    new.done_by_line := null;
  end if;

  if tg_op = 'UPDATE' and old.source <> 'manual'
     and (new.qty is distinct from old.qty or new.unit_id is distinct from old.unit_id or new.note is distinct from old.note) then
    new.source := 'manual';
  end if;
  return new;
end;
$$;

create trigger shopping_list_item_check
  before insert or update on public.shopping_list_item
  for each row execute function private.shopping_item_check();

create trigger shopping_list_item_updated_at
  before update on public.shopping_list_item
  for each row execute function private.set_updated_at();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.shopping_list_item enable row level security;

revoke all on table public.shopping_list_item from anon, authenticated;
grant select, delete on table public.shopping_list_item to authenticated;
-- `source`, `done_by_line` and the stamps are never client-written.
grant insert (id, household_id, list, product_id, free_text, qty, unit_id, note, done)
  on table public.shopping_list_item to authenticated;
grant update (free_text, qty, unit_id, note, done, dismissed)
  on table public.shopping_list_item to authenticated;

create policy shopping_list_item_select on public.shopping_list_item
  for select to authenticated
  using (private.is_member(household_id));

create policy shopping_list_item_insert on public.shopping_list_item
  for insert to authenticated
  with check (private.can_write(household_id));

create policy shopping_list_item_update on public.shopping_list_item
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy shopping_list_item_delete on public.shopping_list_item
  for delete to authenticated
  using (private.can_write(household_id));

-- Two phones in the shop see each other's ticks (Realtime respects the select policy).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.shopping_list_item;
  end if;
end;
$$;

-- ── rpc_shopping_sync: below-minimum products ↔ automatic list items ──────────
-- Idempotent; called when the list or Home opens and after stock changes.
--  · adds a 'below_min' item for each active product below its minimum that has no item on the
--    list since its last stock-in (an item ticked or dismissed after that still counts, so a
--    "not now" isn't undone by the next sync; after new stock arrives it may be added again);
--    qty = reorder qty, else what is missing to reach the minimum (in the stock unit);
--  · removes open automatic items whose product is back at or above its minimum (or archived).
-- A viewer gets zeros (nothing to write). Returns { added, removed }.
create function public.rpc_shopping_sync(p_household uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added   integer;
  v_removed integer;
begin
  if p_household is null or not private.is_member(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not private.can_write(p_household) then
    return jsonb_build_object('added', 0, 'removed', 0);
  end if;

  with low as (
    select p.id, p.stock_unit_id,
           coalesce(p.reorder_qty, p.min_qty - s.qty_effective) as want,
           (select max(m.created_at) from public.stock_movement m
             where m.household_id = p.household_id and m.product_id = p.id and m.delta > 0
               and m.reason in ('purchase', 'adjust')
               and not exists (select 1 from public.stock_movement u where u.reverses_id = m.id)) as last_in
      from public.product p
      join public.v_product_stock s on s.product_id = p.id
     where p.household_id = p_household and not p.archived and s.below_min
  ), ins as (
    insert into public.shopping_list_item (household_id, product_id, qty, unit_id, source)
    select p_household, low.id, low.want, low.stock_unit_id, 'below_min'
      from low
     where low.want > 0
       and not exists (
         select 1 from public.shopping_list_item i
          where i.household_id = p_household and i.list = 'Main' and i.product_id = low.id
            and (not i.done and not i.dismissed or low.last_in is null or i.created_at > low.last_in))
    on conflict do nothing
    returning 1
  )
  select count(*) into v_added from ins;

  with del as (
    delete from public.shopping_list_item i
     where i.household_id = p_household and i.source = 'below_min' and not i.done
       and not exists (
         select 1 from public.product p join public.v_product_stock s on s.product_id = p.id
          where p.id = i.product_id and p.household_id = p_household and not p.archived and s.below_min)
    returning 1
  )
  select count(*) into v_removed from del;

  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$$;

revoke execute on function public.rpc_shopping_sync(uuid) from public, anon;
grant execute on function public.rpc_shopping_sync(uuid) to authenticated;

update public.app_meta set value = '30' where key = 'schema_version';
