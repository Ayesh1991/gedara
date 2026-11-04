-- Phase 10 · 98 — valuables (Didula's choice 2026-11-03: "thing yes, place no")
--
-- * A valuable THING (asset.valuable) stays visible to every member, but where it is kept is the
--   owner's alone: its place lives in asset_place_private (owner-only) and asset.location_id stays
--   null while it is valuable. Its photos, receipts, activity and move history are owner-only too.
-- * A valuable PLACE (location.valuable, e.g. the safe) and everything inside it — child places,
--   things, stock lots and their history, photos, labels — is visible to the owner only.
--   location.in_valuable = the place or any place above it is valuable (kept by triggers).
-- * Only the owner sets either flag (rpc_set_valuable); clients have no grant on the columns.
-- * Ask Gedara (migration 100) never shows valuables to anyone, the owner included.

alter table public.asset add column valuable boolean not null default false;
alter table public.location
  add column valuable    boolean not null default false,
  add column in_valuable boolean not null default false;

create index location_in_valuable_idx on public.location (household_id) where in_valuable;

create table public.asset_place_private (
  household_id uuid not null references public.household (id) on delete cascade,
  asset_id     uuid not null,
  location_id  uuid,
  updated_at   timestamptz not null default now(),
  primary key (household_id, asset_id),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete cascade,
  foreign key (household_id, location_id) references public.location (household_id, id) on delete set null (location_id)
);

alter table public.asset_place_private enable row level security;
revoke all on table public.asset_place_private from anon, authenticated;
grant select on table public.asset_place_private to authenticated;
create policy asset_place_private_select on public.asset_place_private
  for select to authenticated
  using (private.is_owner(household_id));

-- ── Helpers (answer only for the caller; false for the owner) ───────────────────

-- Is this place (or a place above it) valuable, and the caller not the owner?
create function private.location_hidden(p_household uuid, p_location uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_location is not null
     and not private.is_owner(p_household)
     and exists (select 1 from public.location l
                  where l.id = p_location and l.household_id = p_household and l.in_valuable);
$$;

-- Details of an entity (photos, activity, moves) the caller must not see.
create function private.entity_hidden(p_household uuid, p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_id is not null
     and not private.is_owner(p_household)
     and case p_type
           when 'asset' then exists (
             select 1 from public.asset a
               left join public.location l on l.id = a.location_id and l.household_id = a.household_id
              where a.id = p_id and a.household_id = p_household and (a.valuable or coalesce(l.in_valuable, false)))
           when 'location' then exists (
             select 1 from public.location l where l.id = p_id and l.household_id = p_household and l.in_valuable)
           when 'lot' then exists (
             select 1 from public.stock_lot s
               join public.location l on l.id = s.location_id and l.household_id = s.household_id
              where s.id = p_id and s.household_id = p_household and l.in_valuable)
           else false
         end;
$$;

-- A thing kept inside a valuable place (the whole row is hidden from others).
create function private.asset_place_hidden(p_household uuid, p_asset uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_asset is not null
     and private.location_hidden(p_household,
           (select a.location_id from public.asset a where a.id = p_asset and a.household_id = p_household));
$$;

-- An activity row: its entity, or a place it names in its payload.
create function private.activity_hidden(p_household uuid, p_type text, p_id uuid, p_payload jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.is_owner(p_household)
     and (private.entity_hidden(p_household, p_type, p_id)
          or private.location_hidden(p_household, public.safe_uuid(p_payload ->> 'from'))
          or private.location_hidden(p_household, public.safe_uuid(p_payload ->> 'to'))
          or private.location_hidden(p_household, public.safe_uuid(p_payload ->> 'location_id')));
$$;

-- A file in household-files: <household>/<entity_type>/<entity_id>/<file>.
create function private.file_hidden(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.entity_hidden(public.safe_uuid((storage.foldername(p_name))[1]),
                                        (storage.foldername(p_name))[2],
                                        public.safe_uuid((storage.foldername(p_name))[3])), false);
$$;

revoke execute on function private.location_hidden(uuid, uuid) from public, anon;
revoke execute on function private.entity_hidden(uuid, text, uuid) from public, anon;
revoke execute on function private.asset_place_hidden(uuid, uuid) from public, anon;
revoke execute on function private.activity_hidden(uuid, text, uuid, jsonb) from public, anon;
revoke execute on function private.file_hidden(text) from public, anon;
grant execute on function private.asset_place_hidden(uuid, uuid) to authenticated;
grant execute on function private.location_hidden(uuid, uuid) to authenticated;
grant execute on function private.entity_hidden(uuid, text, uuid) to authenticated;
grant execute on function private.activity_hidden(uuid, text, uuid, jsonb) to authenticated;
grant execute on function private.file_hidden(text) to authenticated;

-- ── location.in_valuable ───────────────────────────────────────────────────────
-- SECURITY DEFINER: reads a parent the caller may not see, writes a column clients can't write.
create function private.location_set_in_valuable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.in_valuable := new.valuable or coalesce(
    (select p.in_valuable from public.location p where p.id = new.parent_id and p.household_id = new.household_id),
    false);
  return new;
end;
$$;

create function private.location_cascade_in_valuable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.location c
     set in_valuable = c.valuable or new.in_valuable
   where c.parent_id = new.id and c.household_id = new.household_id
     and c.in_valuable is distinct from (c.valuable or new.in_valuable);
  return null;
end;
$$;

revoke execute on function private.location_set_in_valuable() from public, anon, authenticated;
revoke execute on function private.location_cascade_in_valuable() from public, anon, authenticated;

create trigger location_set_in_valuable
  before insert or update of parent_id, valuable on public.location
  for each row execute function private.location_set_in_valuable();

create trigger location_cascade_in_valuable
  after update on public.location
  for each row when (old.in_valuable is distinct from new.in_valuable)
  execute function private.location_cascade_in_valuable();

-- ── A valuable thing's place goes to asset_place_private ───────────────────────
-- Any write of location_id on a valuable thing (form, rpc_move, scan "kept in") lands here instead.
create function private.asset_valuable_place()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.valuable and new.location_id is not null then
    insert into public.asset_place_private (household_id, asset_id, location_id)
    values (new.household_id, new.id, new.location_id)
    on conflict (household_id, asset_id) do update set location_id = excluded.location_id, updated_at = now();
    new.location_id := null;
  end if;
  return new;
end;
$$;

revoke execute on function private.asset_valuable_place() from public, anon, authenticated;

create trigger asset_valuable_place
  before update of location_id, valuable on public.asset
  for each row execute function private.asset_valuable_place();

-- ── Owner switches a thing or a place ──────────────────────────────────────────
create function public.rpc_set_valuable(p_household uuid, p_kind text, p_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
begin
  if not private.is_owner(p_household) then
    raise exception 'only the owner can mark valuables' using errcode = '42501';
  end if;
  if p_kind not in ('asset', 'location') or p_id is null or p_on is null then
    raise exception 'bad valuable request' using errcode = '22023';
  end if;

  if p_kind = 'location' then
    update public.location set valuable = p_on where id = p_id and household_id = p_household;
    if not found then raise exception 'place not found' using errcode = '22023'; end if;
    return jsonb_build_object('kind', p_kind, 'id', p_id, 'valuable', p_on);
  end if;

  if p_on then
    -- The trigger moves the current place into asset_place_private.
    update public.asset set valuable = true where id = p_id and household_id = p_household;
    if not found then raise exception 'thing not found' using errcode = '22023'; end if;
  else
    select pp.location_id into v_place from public.asset_place_private pp
     where pp.asset_id = p_id and pp.household_id = p_household;
    update public.asset set valuable = false, location_id = coalesce(v_place, location_id)
     where id = p_id and household_id = p_household;
    if not found then raise exception 'thing not found' using errcode = '22023'; end if;
    delete from public.asset_place_private where asset_id = p_id and household_id = p_household;
  end if;
  return jsonb_build_object('kind', p_kind, 'id', p_id, 'valuable', p_on);
end;
$$;

revoke execute on function public.rpc_set_valuable(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.rpc_set_valuable(uuid, text, uuid, boolean) to authenticated;

-- ── rpc_move bypasses RLS: others can't move hidden things/places or move into a hidden place ──
alter function public.rpc_move(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) rename to rpc_move_v58;
alter function public.rpc_move_v58(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) set schema private;
revoke execute on function private.rpc_move_v58(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) from public, anon, authenticated;

create function public.rpc_move(
  p_op_id uuid, p_kind text, p_id uuid, p_to uuid,
  p_client_at timestamptz default null, p_force boolean default false, p_expect jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  if p_kind = 'asset' then
    select a.household_id into v_household from public.asset a where a.id = p_id;
    if v_household is not null and private.asset_place_hidden(v_household, p_id) then
      raise exception 'unknown item' using errcode = '23503';
    end if;
  elsif p_kind = 'location' then
    select l.household_id into v_household from public.location l where l.id = p_id;
    if v_household is not null and private.location_hidden(v_household, p_id) then
      raise exception 'unknown item' using errcode = '23503';
    end if;
  end if;
  if v_household is not null and private.location_hidden(v_household, p_to) then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  return private.rpc_move_v58(p_op_id, p_kind, p_id, p_to, p_client_at, p_force, p_expect);
end;
$$;

revoke execute on function public.rpc_move(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) from public, anon;
grant execute on function public.rpc_move(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) to authenticated;

-- ── Policies ───────────────────────────────────────────────────────────────────
drop policy location_select on public.location;
drop policy location_insert on public.location;
drop policy location_update on public.location;
drop policy location_delete on public.location;
create policy location_select on public.location
  for select to authenticated
  using (private.is_member(household_id) and (not in_valuable or private.is_owner(household_id)));
create policy location_insert on public.location
  for insert to authenticated
  with check (private.can_write(household_id) and not private.location_hidden(household_id, parent_id));
create policy location_update on public.location
  for update to authenticated
  using (private.can_write(household_id) and (not in_valuable or private.is_owner(household_id)))
  with check (private.can_write(household_id) and not private.location_hidden(household_id, parent_id));
create policy location_delete on public.location
  for delete to authenticated
  using (private.can_write(household_id) and (not in_valuable or private.is_owner(household_id)));

drop policy asset_select on public.asset;
drop policy asset_insert on public.asset;
drop policy asset_update on public.asset;
drop policy asset_delete on public.asset;
create policy asset_select on public.asset
  for select to authenticated
  using (private.is_member(household_id) and not private.location_hidden(household_id, location_id));
create policy asset_insert on public.asset
  for insert to authenticated
  with check (private.can_write(household_id) and not private.location_hidden(household_id, location_id));
create policy asset_update on public.asset
  for update to authenticated
  using (private.can_write(household_id) and not private.location_hidden(household_id, location_id))
  with check (private.can_write(household_id) and not private.location_hidden(household_id, location_id));
create policy asset_delete on public.asset
  for delete to authenticated
  using (private.can_write(household_id) and not private.location_hidden(household_id, location_id));

drop policy stock_lot_select on public.stock_lot;
create policy stock_lot_select on public.stock_lot
  for select to authenticated
  using (private.is_member(household_id) and not private.location_hidden(household_id, location_id));
drop policy stock_movement_select on public.stock_movement;
create policy stock_movement_select on public.stock_movement
  for select to authenticated
  using (private.is_member(household_id) and not private.location_hidden(household_id, location_id));

drop policy attachment_select on public.attachment;
drop policy attachment_insert on public.attachment;
drop policy attachment_update on public.attachment;
drop policy attachment_delete on public.attachment;
create policy attachment_select on public.attachment
  for select to authenticated
  using (private.is_member(household_id) and not private.entity_hidden(household_id, entity_type, entity_id));
create policy attachment_insert on public.attachment
  for insert to authenticated
  with check (private.can_write(household_id) and not private.entity_hidden(household_id, entity_type, entity_id));
create policy attachment_update on public.attachment
  for update to authenticated
  using (private.can_write(household_id) and not private.entity_hidden(household_id, entity_type, entity_id))
  with check (private.can_write(household_id) and not private.entity_hidden(household_id, entity_type, entity_id));
create policy attachment_delete on public.attachment
  for delete to authenticated
  using (private.can_write(household_id) and not private.entity_hidden(household_id, entity_type, entity_id));

drop policy household_files_select on storage.objects;
create policy household_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'household-files'
    and private.is_member(public.safe_uuid((storage.foldername(name))[1]))
    and not private.file_hidden(name)
  );

drop policy activity_select on public.activity;
create policy activity_select on public.activity for select to authenticated
  using (private.is_member(household_id)
         and not private.activity_hidden(household_id, entity_type, entity_id, payload));

drop policy move_op_select on public.move_op;
create policy move_op_select on public.move_op
  for select to authenticated
  using (private.is_member(household_id)
         and not private.entity_hidden(household_id, kind, item_id)
         and not private.location_hidden(household_id, from_id)
         and not private.location_hidden(household_id, to_id));

drop policy label_tag_select on public.label_tag;
create policy label_tag_select on public.label_tag
  for select to authenticated
  using (private.is_member(household_id)
         and not private.location_hidden(household_id, location_id)
         and not private.asset_place_hidden(household_id, asset_id));

-- ── v_asset: the owner sees a valuable thing's place; others see "private" ─────
create or replace view public.v_asset
with (security_invoker = true) as
  select a.id, a.household_id, a.asset_no, a.code, a.name, a.description, a.category_id,
         coalesce(a.location_id, pp.location_id) as location_id,
         a.parent_id, a.quantity, a.manufacturer, a.model_no, a.serial_no, a.condition, a.status,
         a.lent_to, a.lent_on, a.transaction_line_id, a.purchase_price, a.purchased_on, a.vendor,
         a.useful_life_months, a.salvage_value, a.warranty_until, a.lifetime_warranty, a.warranty_notes,
         a.insured, a.insurance_notes, a.sold_on, a.sold_to, a.sold_price, a.sale_transaction_id, a.custom,
         a.archived, a.created_by, a.created_at, a.updated_at,
         'A-' || lpad(a.asset_no::text, 4, '0') as tag,
         c.name as category_name,
         c.parent_id as category_parent_id,
         pc.name as category_parent_name,
         l.path as location_path,
         pa.name as parent_name,
         pa.asset_no as parent_asset_no,
         coalesce(ch.parts, 0) as parts,
         coalesce(tg.tag_ids, '{}') as tag_ids,
         coalesce(tg.tag_names, '{}') as tag_names,
         tl.transaction_id as bill_id,
         bt.occurred_on as bill_date,
         bt.payee_text as bill_payee,
         d.today,
         d.months_owned,
         v.book_value,
         case when a.status in ('sold', 'disposed', 'lost') then 0 else v.book_value end as current_value,
         coalesce(mt.maintenance_cost, 0) as maintenance_cost,
         mt.last_maintained_on,
         case when a.purchase_price is null then null
              else a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0) end
           as cost_of_ownership,
         case when a.purchase_price is null or d.months_owned is null then null
              else round((a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0))
                         / greatest(d.months_owned, 1), 2) end
           as cost_per_month,
         case when a.status = 'sold' and a.sold_price is not null and v.book_value is not null
              then a.sold_price - v.book_value end as sale_gain,
         case when a.lifetime_warranty or a.warranty_until is null then null
              else a.warranty_until - d.today end as warranty_days_left,
         pl.next_due,
         a.valuable,
         (a.valuable and pp.asset_id is null) as place_private
    from public.asset a
    join public.household h on h.id = a.household_id
    left join public.asset_place_private pp on pp.asset_id = a.id and pp.household_id = a.household_id
    left join public.category c on c.id = a.category_id and c.household_id = a.household_id
    left join public.category pc on pc.id = c.parent_id and pc.household_id = c.household_id
    left join public.location l on l.id = coalesce(a.location_id, pp.location_id) and l.household_id = a.household_id
    left join public.asset pa on pa.id = a.parent_id and pa.household_id = a.household_id
    left join public.transaction_line tl on tl.id = a.transaction_line_id and tl.household_id = a.household_id
    left join public.money_transaction bt on bt.id = tl.transaction_id and bt.household_id = tl.household_id
    cross join lateral (
      select (now() at time zone h.timezone)::date as today
    ) z
    cross join lateral (
      select z.today,
             case when a.purchased_on is null then null
                  else greatest(0,
                         (extract(year from age(coalesce(case when a.status in ('sold', 'disposed', 'lost')
                                                              then coalesce(a.sold_on, z.today) end, z.today),
                                                     a.purchased_on)) * 12
                        + extract(month from age(coalesce(case when a.status in ('sold', 'disposed', 'lost')
                                                               then coalesce(a.sold_on, z.today) end, z.today),
                                                      a.purchased_on)))::integer)
             end as months_owned
    ) d
    cross join lateral (
      select case
               when a.purchase_price is null then null
               when a.useful_life_months is null or d.months_owned is null then a.purchase_price
               else round(a.purchase_price
                          - (a.purchase_price - least(coalesce(a.salvage_value, 0), a.purchase_price))
                            * least(d.months_owned::numeric / a.useful_life_months, 1), 2)
             end as book_value
    ) v
    left join lateral (
      select count(*)::integer as parts from public.asset x
       where x.household_id = a.household_id and x.parent_id = a.id
    ) ch on true
    left join lateral (
      select array_agg(t.id order by lower(t.name)) as tag_ids, array_agg(t.name order by lower(t.name)) as tag_names
        from public.asset_tag at2 join public.tag t on t.id = at2.tag_id and t.household_id = at2.household_id
       where at2.asset_id = a.id and at2.household_id = a.household_id
    ) tg on true
    left join lateral (
      select sum(g.cost) as maintenance_cost, max(g.done_on) as last_maintained_on
        from public.maintenance_log g
       where g.asset_id = a.id and g.household_id = a.household_id
    ) mt on true
    left join lateral (
      select min(m.next_due) as next_due from public.maintenance_plan m
       where m.asset_id = a.id and m.household_id = a.household_id and m.active
    ) pl on true;

update public.app_meta set value = '98' where key = 'schema_version';
