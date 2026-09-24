-- Phase 2 · 12 — categories (MASTER_PLAN §3.2), seeded from ledger v7 `CATS`
-- One two-level taxonomy (category › sub-category) shared by money now and pantry/things later.
-- `key` is the stable slug of the seeded top levels (ledger v7 ids: grocery, consumable, …) that
-- the bill scanner and the Sheet import map onto; categories you add yourself have no key.

create table public.category (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.household (id) on delete cascade,
  parent_id       uuid,
  key             text check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name            text not null check (length(btrim(name)) between 1 and 60),
  kind            text not null default 'expense' check (kind in ('expense', 'income', 'both')),
  default_destiny text not null default 'expense' check (default_destiny in ('stock', 'asset', 'expense')),
  icon            text check (length(icon) <= 16),
  color           text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort            integer not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, key),
  -- A parent must be in the same household; NO ACTION blocks deleting a category that has subs.
  foreign key (household_id, parent_id) references public.category (household_id, id)
);

-- Names are unique among siblings (case-insensitive); top levels share the all-zero parent slot.
create unique index category_sibling_name_idx on public.category
  (household_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
create index category_parent_idx on public.category (household_id, parent_id);

-- Two levels only; a sub-category takes its parent's kind.
create function private.category_check_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent public.category%rowtype;
begin
  new.name := btrim(new.name);
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'a category cannot be its own parent' using errcode = '23514';
  end if;
  select * into v_parent from public.category c
   where c.id = new.parent_id and c.household_id = new.household_id;
  if not found then
    return new;  -- the composite FK rejects it
  end if;
  if v_parent.parent_id is not null then
    raise exception 'sub-categories cannot have sub-categories' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and exists (select 1 from public.category c where c.parent_id = new.id) then
    raise exception 'a category with sub-categories must stay top-level' using errcode = '23514';
  end if;
  new.kind := v_parent.kind;
  return new;
end;
$$;

create trigger category_check_parent
  before insert or update of parent_id, name, kind on public.category
  for each row execute function private.category_check_parent();

create trigger category_updated_at
  before update on public.category
  for each row execute function private.set_updated_at();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.category enable row level security;

revoke all on table public.category from anon, authenticated;
grant select, delete on table public.category to authenticated;
-- `key` belongs to the seed (import mapping) and is never client-writable.
grant insert (household_id, parent_id, name, kind, default_destiny, icon, color, sort)
  on table public.category to authenticated;
grant update (name, default_destiny, icon, color, sort, archived)
  on table public.category to authenticated;

create policy category_select on public.category
  for select to authenticated
  using (private.is_member(household_id));

create policy category_insert on public.category
  for insert to authenticated
  with check (private.can_write(household_id));

create policy category_update on public.category
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy category_delete on public.category
  for delete to authenticated
  using (private.can_write(household_id));

-- ── Seed: ledger v7 CATS (same names, colours, icons, order) + Income ────────
-- Callable for any household (idempotent); run now for the Gedara household.
create function private.seed_categories(p_household uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_parent uuid;
  v_sub text;
  i integer;
begin
  for r in
    select * from (values
      (1,  'grocery',       'Grocery',         '#6EE7A0', '🛒', 'expense', 'stock',
        array['Rice','Flour & grains','Sugar','Salt & spices','Cooking oil','Vegetables','Fruits','Meat','Fish & seafood','Eggs','Dairy & milk','Bread & bakery','Tea & coffee','Snacks & biscuits','Beverages','Canned & dry goods','Other grocery']),
      (2,  'consumable',    'Consumables',     '#7FB5FF', '🧴', 'expense', 'stock',
        array['Toiletries','Personal care','Cleaning & detergents','Laundry','Kitchen consumables','Baby items','Medicine & pharmacy','Stationery','Other consumable']),
      (3,  'nonconsumable', 'Non-consumables', '#C99BFF', '📦', 'expense', 'asset',
        array['Clothing','Footwear','Electronics','Home appliances','Furniture','Kitchenware','Tools & hardware','Books','Gifts','Other non-consumable']),
      (4,  'energy',        'Energy',          '#FFB35C', '⚡', 'expense', 'expense',
        array['Petrol','Diesel','LP Gas','Electricity','Generator fuel','Other energy']),
      (5,  'water',         'Water',           '#5CD6FF', '💧', 'expense', 'expense',
        array['Water bill','Bottled water','Other water']),
      (6,  'services',      'Services',        '#FF8FA3', '🧾', 'expense', 'expense',
        array['Insurance','Mobile & telephone','Internet','TV & streaming','Banking & fees','Subscriptions','Domestic help','Repairs & maintenance','Education','Medical services','Other service']),
      (7,  'dining',        'Dining out',      '#FFD166', '🍽️', 'expense', 'expense',
        array['Restaurant','Takeaway','Delivery','Canteen / office','Tea shop / snacks','Other dining']),
      (8,  'transport',     'Transport',       '#9AE6B4', '🚌', 'expense', 'expense',
        array['Bus & train','Taxi / PickMe / Uber','Vehicle service','Spare parts & tyres','Parking & tolls','Licence & revenue','Other transport']),
      (9,  'other',         'Other',           '#A0AAB8', '📎', 'expense', 'expense',
        array['Charity & donations','Festivals & events','Miscellaneous']),
      (10, 'income',        'Income',          '#2FC6A0', '💰', 'income',  'expense',
        array['Salary','Private practice','Interest','Gifts received','Other income'])
    ) as t (sort, key, name, color, icon, kind, destiny, subs)
  loop
    insert into public.category (household_id, key, name, color, icon, kind, default_destiny, sort)
    values (p_household, r.key, r.name, r.color, r.icon, r.kind, r.destiny, r.sort)
    on conflict (household_id, key) do nothing;

    select c.id into v_parent from public.category c
     where c.household_id = p_household and c.key = r.key;

    i := 0;
    foreach v_sub in array r.subs loop
      i := i + 1;
      if not exists (
        select 1 from public.category c
         where c.household_id = p_household and c.parent_id = v_parent and lower(c.name) = lower(v_sub)
      ) then
        insert into public.category (household_id, parent_id, name, kind, default_destiny, sort)
        values (p_household, v_parent, v_sub, r.kind, r.destiny, i);
      end if;
    end loop;
  end loop;
end;
$$;

revoke execute on function private.seed_categories(uuid) from public, anon, authenticated;

do $$
declare
  v_household uuid;
begin
  select id into v_household from public.household where name = 'Gedara' order by created_at limit 1;
  if v_household is not null then
    perform private.seed_categories(v_household);
  end if;
end;
$$;

update public.app_meta set value = '12' where key = 'schema_version';
