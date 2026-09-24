-- Phase 3 · 26 — stock RPCs (MASTER_PLAN §3.4, CLAUDE.md rule 1)
-- The only way stock changes. Each RPC is SECURITY DEFINER, checks private.can_write(), appends
-- `stock_movement` rows (the trigger of migration 25 moves qty_remaining) and returns the
-- `correlation_id` of what it did, which `rpc_undo` reverses as one unit.
--
-- Quantities come in any unit the product understands (private.to_stock_qty) and are stored in the
-- product's stock unit. FEFO order everywhere: opened lots first, then the earliest due date (no
-- date last), then the oldest purchase. Lots are locked (FOR UPDATE, in that fixed order), so two
-- phones using the same jar at once can't take more than is there.
--
-- Error codes the app maps to messages:
--   42501 not allowed · 23503 unknown product / lot / place · 23514 bad input
--   GDSTK not enough stock (DETAIL = what is available, in stock units)
--   GDUNT this unit can't be converted to the product's stock unit
--   GDUND can't undo (already undone, or the stock was used / changed since)

-- ── Helpers (not callable by clients) ────────────────────────────────────────

create function private.household_today(p_household uuid)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone coalesce(
            (select h.timezone from public.household h where h.id = p_household), 'Asia/Colombo'))::date
$$;

-- Units that measure the same physical thing (mass, volume …) convert by `to_base`; 'other' units
-- (pack, bottle …) only through a product conversion.
create function private.unit_factor(p_from uuid, p_to uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
           when p_from = p_to then 1::numeric
           when f.dimension = t.dimension and f.dimension <> 'other' then f.to_base / t.to_base
         end
    from public.unit f, public.unit t
   where f.id = p_from and t.id = p_to
$$;

-- qty in p_unit → qty in the product's stock unit. Tries: the same dimension; a conversion from
-- p_unit ("1 pack = 400 g"); a conversion from the stock unit, backwards ("1 jar = 50 g" with a
-- stock unit of jars and a quantity in g).
create function private.to_stock_qty(p_product uuid, p_unit uuid, p_qty numeric)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_stock uuid;
  v_f     numeric;
  v_conv  public.product_unit_conversion%rowtype;
begin
  select p.stock_unit_id into v_stock from public.product p where p.id = p_product;
  if p_unit is null or p_unit = v_stock then
    return round(p_qty, 4);
  end if;

  v_f := private.unit_factor(p_unit, v_stock);
  if v_f is not null then
    return round(p_qty * v_f, 4);
  end if;

  for v_conv in
    select c.* from public.product_unit_conversion c where c.product_id = p_product and c.from_unit_id = p_unit
  loop
    v_f := private.unit_factor(v_conv.to_unit_id, v_stock);
    if v_f is not null then
      return round(p_qty * v_conv.factor * v_f, 4);
    end if;
  end loop;

  for v_conv in
    select c.* from public.product_unit_conversion c where c.product_id = p_product and c.from_unit_id = v_stock
  loop
    v_f := private.unit_factor(p_unit, v_conv.to_unit_id);
    if v_f is not null then
      return round(p_qty * v_f / v_conv.factor, 4);
    end if;
  end loop;

  raise exception 'this unit can''t be converted to the product''s stock unit' using errcode = 'GDUNT';
end;
$$;

-- The household's product (locked for share so its settings don't change mid-action), or 23503.
create function private.stock_product(p_household uuid, p_product uuid)
returns public.product
language plpgsql
set search_path = ''
as $$
declare
  v public.product%rowtype;
begin
  select * into v from public.product p where p.id = p_product and p.household_id = p_household for share;
  if not found then
    raise exception 'unknown product' using errcode = '23503';
  end if;
  return v;
end;
$$;

-- Due date for new stock: explicit > frozen days (freezer place) > default days; none for 'none'.
create function private.default_due(p public.product, p_location uuid, p_from date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_climate text;
begin
  if p.due_type = 'none' then
    return null;
  end if;
  select l.climate into v_climate from public.location l where l.id = p_location;
  if v_climate = 'freezer' and p.due_days_frozen is not null then
    return p_from + p.due_days_frozen;
  end if;
  if p.default_due_days is not null then
    return p_from + p.default_due_days;
  end if;
  return null;
end;
$$;

-- A new lot and its first movement (+qty). Returns the lot id.
create function private.stock_new_lot(
  p_household uuid, p_product uuid, p_qty numeric, p_location uuid, p_unit_cost numeric,
  p_purchased_on date, p_due date, p_opened_at timestamptz, p_split_from uuid, p_line uuid,
  p_reason text, p_correlation uuid, p_note text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_lot uuid;
begin
  insert into public.stock_lot
    (household_id, product_id, location_id, qty_initial, unit_cost, purchased_on, due_date, opened_at,
     split_from_id, transaction_line_id, note)
  values
    (p_household, p_product, p_location, p_qty, p_unit_cost, p_purchased_on, p_due, p_opened_at,
     p_split_from, p_line, p_note)
  returning id into v_lot;
  insert into public.stock_movement
    (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, note)
  values
    (p_household, v_lot, p_product, p_qty, p_reason, p_location, p_unit_cost, p_correlation, p_note);
  return v_lot;
end;
$$;

-- Take p_qty (null = everything) from the product's lots in FEFO order, optionally only from one
-- place or one lot. Returns what was taken and what it cost.
create function private.stock_take(
  p_household uuid, p_product uuid, p_qty numeric, p_location uuid, p_lot uuid,
  p_reason text, p_correlation uuid, p_note text,
  out taken numeric, out cost numeric, out lots integer)
language plpgsql
set search_path = ''
as $$
declare
  v_lot  public.stock_lot%rowtype;
  v_have numeric;
  v_take numeric;
  v_left numeric := p_qty;
begin
  taken := 0; cost := 0; lots := 0;

  -- Lock every candidate first (fixed order), then check there is enough.
  perform 1 from public.stock_lot l
   where l.household_id = p_household and l.product_id = p_product and l.qty_remaining > 0
     and (p_lot is null or l.id = p_lot)
     and (p_location is null or l.location_id = p_location)
   order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
   for update;
  select coalesce(sum(l.qty_remaining), 0) into v_have from public.stock_lot l
   where l.household_id = p_household and l.product_id = p_product and l.qty_remaining > 0
     and (p_lot is null or l.id = p_lot)
     and (p_location is null or l.location_id = p_location);

  if v_have = 0 or (p_qty is not null and v_have < p_qty) then
    raise exception 'not enough stock' using errcode = 'GDSTK', detail = v_have::text;
  end if;

  for v_lot in
    select l.* from public.stock_lot l
     where l.household_id = p_household and l.product_id = p_product and l.qty_remaining > 0
       and (p_lot is null or l.id = p_lot)
       and (p_location is null or l.location_id = p_location)
     order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
  loop
    exit when v_left is not null and v_left <= 0;
    v_take := case when v_left is null then v_lot.qty_remaining else least(v_left, v_lot.qty_remaining) end;
    insert into public.stock_movement
      (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, note)
    values
      (p_household, v_lot.id, p_product, -v_take, p_reason, v_lot.location_id, v_lot.unit_cost, p_correlation, p_note);
    taken := taken + v_take;
    cost := cost + v_take * coalesce(v_lot.unit_cost, 0);
    lots := lots + 1;
    v_left := v_left - v_take;
  end loop;
  cost := round(cost, 2);
end;
$$;

-- An 'edit' / whole-lot movement records the lot fields it changed so undo can put them back.
create function private.lot_state(l public.stock_lot, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_object_agg(k, to_jsonb(l) -> k) from unnest(p_keys) k
$$;

revoke execute on function private.household_today(uuid) from public, anon, authenticated;
revoke execute on function private.unit_factor(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.to_stock_qty(uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function private.stock_product(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.default_due(public.product, uuid, date) from public, anon, authenticated;
revoke execute on function private.stock_new_lot(uuid, uuid, numeric, uuid, numeric, date, date, timestamptz, uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
revoke execute on function private.stock_take(uuid, uuid, numeric, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function private.lot_state(public.stock_lot, text[]) from public, anon, authenticated;

-- ── rpc_purchase: new stock ───────────────────────────────────────────────────
-- p: { household_id, product_id, qty, unit_id?, location_id? (default: the product's place),
--      total_cost? (Rs for the whole quantity), purchased_on?, due_date?, transaction_line_id?, note? }
create function public.rpc_purchase(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_product   public.product%rowtype;
  v_qty       numeric;
  v_cost      numeric := (p ->> 'total_cost')::numeric;
  v_location  uuid;
  v_on        date;
  v_due       date;
  v_corr      uuid := gen_random_uuid();
  v_lot       uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_product := private.stock_product(v_household, (p ->> 'product_id')::uuid);
  v_qty := private.to_stock_qty(v_product.id, (p ->> 'unit_id')::uuid, (p ->> 'qty')::numeric);
  if v_qty is null or v_qty <= 0 then
    raise exception 'quantity must be more than 0' using errcode = '23514';
  end if;
  if v_cost is not null and v_cost < 0 then
    raise exception 'cost can''t be negative' using errcode = '23514';
  end if;

  v_location := coalesce((p ->> 'location_id')::uuid, v_product.default_location_id);
  v_on := coalesce((p ->> 'purchased_on')::date, private.household_today(v_household));
  v_due := case when p ? 'due_date' then (p ->> 'due_date')::date
                else private.default_due(v_product, v_location, v_on) end;

  v_lot := private.stock_new_lot(
    v_household, v_product.id, v_qty, v_location, round(v_cost / v_qty, 4), v_on, v_due, null, null,
    (p ->> 'transaction_line_id')::uuid, 'purchase', v_corr, nullif(btrim(p ->> 'note'), ''));

  return jsonb_build_object('correlation_id', v_corr, 'lot_id', v_lot, 'qty', v_qty);
end;
$$;

-- ── rpc_consume: use up or waste, FEFO ────────────────────────────────────────
-- p: { household_id, product_id, qty? (omit with all=true), unit_id?, all?, location_id?, lot_id?,
--      reason? ('consume' | 'waste'), note? }
create function public.rpc_consume(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_product   public.product%rowtype;
  v_reason    text := coalesce(p ->> 'reason', 'consume');
  v_qty       numeric;
  v_corr      uuid := gen_random_uuid();
  r           record;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_reason not in ('consume', 'waste') then
    raise exception 'reason must be consume or waste' using errcode = '23514';
  end if;
  v_product := private.stock_product(v_household, (p ->> 'product_id')::uuid);
  if coalesce((p ->> 'all')::boolean, false) then
    v_qty := null;
  else
    v_qty := private.to_stock_qty(v_product.id, (p ->> 'unit_id')::uuid, (p ->> 'qty')::numeric);
    if v_qty is null or v_qty <= 0 then
      raise exception 'quantity must be more than 0' using errcode = '23514';
    end if;
  end if;

  select * into r from private.stock_take(v_household, v_product.id, v_qty, (p ->> 'location_id')::uuid,
                                          (p ->> 'lot_id')::uuid, v_reason, v_corr, nullif(btrim(p ->> 'note'), ''));
  return jsonb_build_object('correlation_id', v_corr, 'qty', r.taken, 'cost', r.cost, 'lots', r.lots);
end;
$$;

-- ── rpc_open: mark opened (the part you opened becomes its own lot) ───────────
-- p: { household_id, lot_id? | product_id (+ location_id?), qty? + unit_id? (default: the whole lot) }
-- Due date becomes min(due, today + due_days_after_open).
create function public.rpc_open(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_product   public.product%rowtype;
  v_lot       public.stock_lot%rowtype;
  v_qty       numeric;
  v_due       date;
  v_corr      uuid := gen_random_uuid();
  v_new       uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p ? 'lot_id' then
    select * into v_lot from public.stock_lot l
     where l.id = (p ->> 'lot_id')::uuid and l.household_id = v_household
     for update;
    if not found then
      raise exception 'unknown lot' using errcode = '23503';
    end if;
    v_product := private.stock_product(v_household, v_lot.product_id);
  else
    v_product := private.stock_product(v_household, (p ->> 'product_id')::uuid);
    select * into v_lot from public.stock_lot l
     where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
       and l.opened_at is null
       and (not p ? 'location_id' or l.location_id = (p ->> 'location_id')::uuid)
     order by l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
     limit 1
     for update;
  end if;
  if v_lot.id is null or v_lot.qty_remaining <= 0 or v_lot.opened_at is not null then
    raise exception 'nothing unopened to open' using errcode = 'GDSTK', detail = '0';
  end if;

  v_qty := case when p ? 'qty' then private.to_stock_qty(v_product.id, (p ->> 'unit_id')::uuid, (p ->> 'qty')::numeric)
                else v_lot.qty_remaining end;
  if v_qty is null or v_qty <= 0 then
    raise exception 'quantity must be more than 0' using errcode = '23514';
  end if;
  if v_qty > v_lot.qty_remaining then
    raise exception 'not enough stock' using errcode = 'GDSTK', detail = v_lot.qty_remaining::text;
  end if;

  v_due := v_lot.due_date;
  if v_product.due_days_after_open is not null then
    v_due := least(coalesce(v_due, 'infinity'::date), private.household_today(v_household) + v_product.due_days_after_open);
  end if;

  if v_qty = v_lot.qty_remaining then
    insert into public.stock_movement
      (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, meta)
    values
      (v_household, v_lot.id, v_product.id, 0, 'open', v_lot.location_id, v_lot.unit_cost, v_corr,
       jsonb_build_object('before', private.lot_state(v_lot, '{opened_at,due_date}'),
                          'after', jsonb_build_object('opened_at', now(), 'due_date', v_due)));
    update public.stock_lot l set opened_at = now(), due_date = v_due where l.id = v_lot.id;
    v_new := v_lot.id;
  else
    insert into public.stock_movement
      (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id)
    values
      (v_household, v_lot.id, v_product.id, -v_qty, 'open', v_lot.location_id, v_lot.unit_cost, v_corr);
    v_new := private.stock_new_lot(
      v_household, v_product.id, v_qty, v_lot.location_id, v_lot.unit_cost, v_lot.purchased_on, v_due, now(),
      v_lot.id, v_lot.transaction_line_id, 'open', v_corr, null);
  end if;

  return jsonb_build_object('correlation_id', v_corr, 'lot_id', v_new, 'qty', v_qty);
end;
$$;

-- ── rpc_transfer: move stock to another place ─────────────────────────────────
-- p: { household_id, to_location_id, lot_id? | product_id (+ from_location_id?), qty? + unit_id?
--      (default: everything selected) }
-- Whole lots move; a part of a lot splits off into a new lot. Moving into a freezer from somewhere
-- else restarts the due date at today + due_days_frozen (when the product has it).
create function public.rpc_transfer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_to        uuid := (p ->> 'to_location_id')::uuid;
  v_to_climate text;
  v_product   public.product%rowtype;
  v_product_id uuid;
  v_lot       public.stock_lot%rowtype;
  v_lot_id    uuid := (p ->> 'lot_id')::uuid;
  v_from      uuid := (p ->> 'from_location_id')::uuid;
  v_qty       numeric;
  v_left      numeric;
  v_have      numeric;
  v_take      numeric;
  v_due       date;
  v_corr      uuid := gen_random_uuid();
  v_moved     numeric := 0;
  v_lots      integer := 0;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select l.climate into v_to_climate from public.location l where l.id = v_to and l.household_id = v_household;
  if not found then
    raise exception 'unknown place' using errcode = '23503';
  end if;

  if v_lot_id is not null then
    select l.product_id into v_product_id from public.stock_lot l where l.id = v_lot_id and l.household_id = v_household;
    if not found then
      raise exception 'unknown lot' using errcode = '23503';
    end if;
  else
    v_product_id := (p ->> 'product_id')::uuid;
  end if;
  v_product := private.stock_product(v_household, v_product_id);
  v_qty := case when p ? 'qty' then private.to_stock_qty(v_product.id, (p ->> 'unit_id')::uuid, (p ->> 'qty')::numeric) end;
  if p ? 'qty' and (v_qty is null or v_qty <= 0) then
    raise exception 'quantity must be more than 0' using errcode = '23514';
  end if;

  -- Same FEFO order and locking as stock_take; lots already at the destination are skipped.
  perform 1 from public.stock_lot l
   where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
     and (v_lot_id is null or l.id = v_lot_id)
     and (v_from is null or l.location_id = v_from)
     and l.location_id is distinct from v_to
   order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
   for update;
  select coalesce(sum(l.qty_remaining), 0) into v_have from public.stock_lot l
   where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
     and (v_lot_id is null or l.id = v_lot_id)
     and (v_from is null or l.location_id = v_from)
     and l.location_id is distinct from v_to;
  if v_have = 0 or (v_qty is not null and v_have < v_qty) then
    raise exception 'not enough stock' using errcode = 'GDSTK', detail = v_have::text;
  end if;

  v_left := v_qty;
  for v_lot in
    select l.* from public.stock_lot l
     where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
       and (v_lot_id is null or l.id = v_lot_id)
       and (v_from is null or l.location_id = v_from)
       and l.location_id is distinct from v_to
     order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
  loop
    exit when v_left is not null and v_left <= 0;
    v_take := case when v_left is null then v_lot.qty_remaining else least(v_left, v_lot.qty_remaining) end;

    v_due := v_lot.due_date;
    if v_to_climate = 'freezer' and v_product.due_days_frozen is not null and v_product.due_type <> 'none'
       and coalesce((select l.climate from public.location l where l.id = v_lot.location_id), '') <> 'freezer' then
      v_due := private.household_today(v_household) + v_product.due_days_frozen;
    end if;

    insert into public.stock_movement
      (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id)
    values
      (v_household, v_lot.id, v_product.id, -v_take, 'transfer_out', v_lot.location_id, v_lot.unit_cost, v_corr);

    if v_take = v_lot.qty_remaining then
      insert into public.stock_movement
        (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, meta)
      values
        (v_household, v_lot.id, v_product.id, v_take, 'transfer_in', v_to, v_lot.unit_cost, v_corr,
         jsonb_build_object('before', private.lot_state(v_lot, '{location_id,due_date}'),
                            'after', jsonb_build_object('location_id', v_to, 'due_date', v_due)));
      update public.stock_lot l set location_id = v_to, due_date = v_due where l.id = v_lot.id;
    else
      perform private.stock_new_lot(
        v_household, v_product.id, v_take, v_to, v_lot.unit_cost, v_lot.purchased_on, v_due, v_lot.opened_at,
        v_lot.id, v_lot.transaction_line_id, 'transfer_in', v_corr, null);
    end if;

    v_moved := v_moved + v_take;
    v_lots := v_lots + 1;
    v_left := v_left - v_take;
  end loop;

  return jsonb_build_object('correlation_id', v_corr, 'qty', v_moved, 'lots', v_lots);
end;
$$;

-- ── rpc_inventory: "I counted it, there are N" ────────────────────────────────
-- p: { household_id, product_id, qty (counted), unit_id?, location_id? (null = count the whole
--      product everywhere), due_date? (for surplus) }
-- A shortfall comes off FEFO; a surplus becomes a new lot at the last known cost. Reason 'adjust'.
create function public.rpc_inventory(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_product   public.product%rowtype;
  v_location  uuid := (p ->> 'location_id')::uuid;
  v_counted   numeric;
  v_have      numeric;
  v_diff      numeric;
  v_cost      numeric;
  v_new_loc   uuid;
  v_today     date;
  v_corr      uuid := gen_random_uuid();
  r           record;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_product := private.stock_product(v_household, (p ->> 'product_id')::uuid);
  v_counted := private.to_stock_qty(v_product.id, (p ->> 'unit_id')::uuid, (p ->> 'qty')::numeric);
  if v_counted is null or v_counted < 0 then
    raise exception 'count can''t be negative' using errcode = '23514';
  end if;

  perform 1 from public.stock_lot l
   where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
     and (v_location is null or l.location_id = v_location)
   order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
   for update;
  select coalesce(sum(l.qty_remaining), 0) into v_have from public.stock_lot l
   where l.household_id = v_household and l.product_id = v_product.id and l.qty_remaining > 0
     and (v_location is null or l.location_id = v_location);
  v_diff := v_counted - v_have;

  if v_diff = 0 then
    return jsonb_build_object('correlation_id', null, 'delta', 0);
  end if;

  if v_diff < 0 then
    select * into r from private.stock_take(v_household, v_product.id, -v_diff, v_location, null, 'adjust', v_corr,
                                            nullif(btrim(p ->> 'note'), ''));
  else
    select l.unit_cost into v_cost from public.stock_lot l
     where l.household_id = v_household and l.product_id = v_product.id and l.unit_cost is not null
     order by l.purchased_on desc nulls last, l.created_at desc
     limit 1;
    v_new_loc := coalesce(v_location, v_product.default_location_id);
    v_today := private.household_today(v_household);
    perform private.stock_new_lot(
      v_household, v_product.id, v_diff, v_new_loc, v_cost, v_today,
      case when p ? 'due_date' then (p ->> 'due_date')::date else private.default_due(v_product, v_new_loc, v_today) end,
      null, null, null, 'adjust', v_corr, nullif(btrim(p ->> 'note'), ''));
  end if;

  return jsonb_build_object('correlation_id', v_corr, 'delta', v_diff);
end;
$$;

-- ── rpc_set_lot_due: "still fine — extend 30 days" (MASTER_PLAN §0.1 #3) ──────
-- p: { household_id, lot_id, due_date (null = no date) }
create function public.rpc_set_lot_due(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_lot       public.stock_lot%rowtype;
  v_due       date := (p ->> 'due_date')::date;
  v_corr      uuid := gen_random_uuid();
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p ? 'due_date' then
    raise exception 'due_date is required (null clears it)' using errcode = '23514';
  end if;
  select * into v_lot from public.stock_lot l
   where l.id = (p ->> 'lot_id')::uuid and l.household_id = v_household
   for update;
  if not found then
    raise exception 'unknown lot' using errcode = '23503';
  end if;
  if v_lot.due_date is not distinct from v_due then
    return jsonb_build_object('correlation_id', null);
  end if;

  insert into public.stock_movement
    (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, meta)
  values
    (v_household, v_lot.id, v_lot.product_id, 0, 'edit', v_lot.location_id, v_lot.unit_cost, v_corr,
     jsonb_build_object('before', private.lot_state(v_lot, '{due_date}'),
                        'after', jsonb_build_object('due_date', v_due)));
  update public.stock_lot l set due_date = v_due where l.id = v_lot.id;
  return jsonb_build_object('correlation_id', v_corr);
end;
$$;

-- ── rpc_undo: reverse one action (the 8 s Undo toast and the journal) ─────────
-- Refused (GDUND) when it was already undone, or when any lot it touched has changed since
-- (a later action that wasn't itself undone): undoing then would rewrite history out of order.
create function public.rpc_undo(p_correlation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_last_seq  bigint;
  v_corr      uuid := gen_random_uuid();
  m           public.stock_movement%rowtype;
  v_count     integer := 0;
begin
  select m0.household_id, max(m0.seq) into v_household, v_last_seq
    from public.stock_movement m0
   where m0.correlation_id = p_correlation and m0.reason <> 'undo'
   group by m0.household_id;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- Lock the touched lots (id order) so nothing slips in between the checks and the reversal.
  perform 1 from public.stock_lot l
   where l.id in (select m1.lot_id from public.stock_movement m1 where m1.correlation_id = p_correlation)
   order by l.id
   for update;

  if exists (select 1 from public.stock_movement u
              join public.stock_movement m1 on m1.id = u.reverses_id
             where m1.correlation_id = p_correlation) then
    raise exception 'already undone' using errcode = 'GDUND';
  end if;
  if exists (
    select 1 from public.stock_movement later
     where later.lot_id in (select m1.lot_id from public.stock_movement m1 where m1.correlation_id = p_correlation)
       and later.seq > v_last_seq
       and later.reason <> 'undo'
       and not exists (select 1 from public.stock_movement u where u.reverses_id = later.id)
  ) then
    raise exception 'this stock has changed since' using errcode = 'GDUND';
  end if;

  for m in
    select * from public.stock_movement m1
     where m1.correlation_id = p_correlation and m1.reason <> 'undo'
     order by m1.seq desc
  loop
    insert into public.stock_movement
      (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, reverses_id, meta)
    values
      (m.household_id, m.lot_id, m.product_id, -m.delta, 'undo', m.location_id, m.unit_cost, v_corr, m.id, m.meta);
    if m.meta ? 'before' then
      update public.stock_lot l set
        location_id = case when m.meta -> 'before' ? 'location_id'
                           then (m.meta #>> '{before,location_id}')::uuid else l.location_id end,
        opened_at   = case when m.meta -> 'before' ? 'opened_at'
                           then (m.meta #>> '{before,opened_at}')::timestamptz else l.opened_at end,
        due_date    = case when m.meta -> 'before' ? 'due_date'
                           then (m.meta #>> '{before,due_date}')::date else l.due_date end
       where l.id = m.lot_id;
    end if;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('correlation_id', v_corr, 'movements', v_count);
end;
$$;

revoke execute on function public.rpc_purchase(jsonb) from public, anon;
revoke execute on function public.rpc_consume(jsonb) from public, anon;
revoke execute on function public.rpc_open(jsonb) from public, anon;
revoke execute on function public.rpc_transfer(jsonb) from public, anon;
revoke execute on function public.rpc_inventory(jsonb) from public, anon;
revoke execute on function public.rpc_set_lot_due(jsonb) from public, anon;
revoke execute on function public.rpc_undo(uuid) from public, anon;
grant execute on function public.rpc_purchase(jsonb) to authenticated;
grant execute on function public.rpc_consume(jsonb) to authenticated;
grant execute on function public.rpc_open(jsonb) to authenticated;
grant execute on function public.rpc_transfer(jsonb) to authenticated;
grant execute on function public.rpc_inventory(jsonb) to authenticated;
grant execute on function public.rpc_set_lot_due(jsonb) to authenticated;
grant execute on function public.rpc_undo(uuid) to authenticated;

update public.app_meta set value = '26' where key = 'schema_version';
