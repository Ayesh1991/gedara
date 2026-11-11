-- Phase 11 · 107 — what a scan at the bin does to the stock (Didula's choices, 2026-11-10)
-- The scanner has no login, so (as for the scale, migration 65) the stock work lives in private
-- functions without the auth.uid() checks: rpc_open and rpc_undo become thin wrappers around their
-- unchanged bodies, and private.bin_apply uses those cores plus stock_take / stock_new_lot /
-- stock_transfer_core. Everything is still a stock_movement row (rule 1).
--
--   Used    pieces: −1 (× the number typed). A pack with a size (g, ml): the pack in progress is
--           finished: an opened pack is emptied; a pack someone already took part of loses the rest;
--           otherwise one pack size goes. A product that lives in a kitchen-scale jar: the pack is
--           MOVED into the jar (the scale counts the grams), or nothing when it is already there.
--           Nothing in stock: the product goes on the shopping list, as it does when the last one goes.
--   Add     + one pack; waits for a person when a bill stocked the same product in the last 3 days.
--   Opened  the oldest unopened pack is marked opened.
--   Waste   like Used, recorded as waste (no jar rule, no shopping list).
--   Check   looks, changes nothing.
-- Which pack: the app's order everywhere (opened first, earliest date, oldest); a HL:LOT label
-- means that exact lot.

-- ── Core of rpc_open (migration 26), unchanged apart from the caller check ────
create function private.stock_open_core(p_household uuid, p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid := p_household;
  v_product   public.product%rowtype;
  v_lot       public.stock_lot%rowtype;
  v_qty       numeric;
  v_due       date;
  v_corr      uuid := gen_random_uuid();
  v_new       uuid;
begin
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

create or replace function public.rpc_open(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.stock_open_core(v_household, p);
end;
$$;

-- ── Core of rpc_undo (migration 69), unchanged apart from the caller check ────
create function private.stock_undo_core(p_correlation uuid)
returns jsonb
language plpgsql
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
  if v_household is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if exists (select 1 from public.stock_movement m2
              where m2.correlation_id = p_correlation and m2.meta ?| array['merged_into', 'merged_from']) then
    raise exception 'a merge can''t be undone' using errcode = 'GDUND';
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

create or replace function public.rpc_undo(p_correlation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select m0.household_id into v_household
    from public.stock_movement m0
   where m0.correlation_id = p_correlation and m0.reason <> 'undo'
   limit 1;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.stock_undo_core(p_correlation);
end;
$$;

-- ── What a scanned text means ─────────────────────────────────────────────────
-- Returns { code_kind, product_id?, lot_id?, pack_qty?, pack_unit?, linkable? }.
--   a Gedara label, raw or as the URL of an A4 label (…/s/HL:PRD:XXXXXX): product / lot / tag,
--     or place / thing (not pantry);
--   a shop barcode: the household's product_barcode (a 12-digit UPC-A and its 13-digit EAN form
--     are the same code), else a Thing's barcode, else unknown and linkable;
--   anything else: 'other'.
create function private.bin_resolve(p_household uuid, p_code text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_hl   text;
  v_id   uuid;
  v_id2  uuid;
  v_bc   public.product_barcode%rowtype;
  v_tag  public.label_tag%rowtype;
begin
  v_hl := upper(substring(v_code from
            '^(?:[Hh][Tt][Tt][Pp][Ss]?://[A-Za-z0-9.-]{1,60}/s/)?([Hh][Ll]:(?:[Ll][Oo][Cc]|[Pp][Rr][Dd]|[Aa][Ss][Tt]|[Ll][Oo][Tt]|[Tt][Aa][Gg]):[0-9A-Za-z]{6})$'));
  if v_hl is not null then
    if v_hl like 'HL:LOC:%' then
      return jsonb_build_object('code_kind', 'place');
    elsif v_hl like 'HL:AST:%' then
      return jsonb_build_object('code_kind', 'thing');
    elsif v_hl like 'HL:PRD:%' then
      select p.id into v_id from public.product p where p.household_id = p_household and p.code = v_hl;
      return jsonb_build_object('code_kind', 'product', 'product_id', v_id);
    elsif v_hl like 'HL:LOT:%' then
      select l.id, l.product_id into v_id, v_id2 from public.stock_lot l
       where l.household_id = p_household and l.code = v_hl;
      return jsonb_build_object('code_kind', 'lot', 'lot_id', v_id, 'product_id', v_id2);
    else
      select * into v_tag from public.label_tag t
       where t.household_id = p_household and t.code = v_hl and t.retired_at is null;
      if not found then
        return jsonb_build_object('code_kind', 'tag');
      elsif v_tag.location_id is not null then
        return jsonb_build_object('code_kind', 'place');
      elsif v_tag.asset_id is not null then
        return jsonb_build_object('code_kind', 'thing');
      end if;
      -- a blank label of ours can still be given to a product
      return jsonb_build_object('code_kind', 'tag', 'product_id', v_tag.product_id,
                                'linkable', v_tag.product_id is null);
    end if;
  end if;

  if v_code ~ '^[0-9A-Za-z._-]{4,64}$' then
    select * into v_bc from public.product_barcode b
     where b.household_id = p_household
       and b.barcode in (v_code,
                         case when v_code ~ '^[0-9]{12}$' then '0' || v_code end,
                         case when v_code ~ '^0[0-9]{12}$' then substr(v_code, 2) end)
     order by (b.barcode = v_code) desc
     limit 1;
    if found then
      return jsonb_build_object('code_kind', 'barcode', 'product_id', v_bc.product_id,
                                'pack_qty', v_bc.qty, 'pack_unit', v_bc.unit_id);
    end if;
    if exists (select 1 from public.asset_barcode a where a.household_id = p_household and a.barcode = v_code) then
      return jsonb_build_object('code_kind', 'thing');
    end if;
    return jsonb_build_object('code_kind', 'barcode', 'linkable', true);
  end if;
  return jsonb_build_object('code_kind', 'other');
end;
$$;

create function private.bin_left(p_household uuid, p_product uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(l.qty_remaining), 0) from public.stock_lot l
   where l.household_id = p_household and l.product_id = p_product and l.qty_remaining > 0
$$;

-- "Finished at the bin": one open line per product (the list's own rule); a line the person said
-- "not now" to is respected. Returns the new line's id, or null when it was already there.
create function private.bin_list_add(p_household uuid, p_product public.product)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_product.archived then
    return null;
  end if;
  insert into public.shopping_list_item (household_id, product_id, qty, unit_id, source)
  select p_household, p_product.id, p_product.reorder_qty,
         case when p_product.reorder_qty is not null then p_product.stock_unit_id end, 'scanner'
   where not exists (select 1 from public.shopping_list_item i
                      where i.household_id = p_household and i.list = 'Main' and i.product_id = p_product.id
                        and not i.done)
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- ── The rule ──────────────────────────────────────────────────────────────────
-- Returns { status, code_kind, product_id, lot_id, name, unit, sized, pack, qty, left_qty, due,
--           on_list, list_item_id, ticked, jar, bill_qty, bill_on, correlation_id }.
-- p_force: a person said "add it anyway" (skips the bill guard).
create function private.bin_apply(p_household uuid, p_mode text, p_count integer, p_code text, p_force boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r         jsonb := private.bin_resolve(p_household, p_code);
  v_kind    text := r ->> 'code_kind';
  v_count   integer := least(greatest(coalesce(p_count, 1), 1), 20);
  v_product public.product%rowtype;
  v_lot_id  uuid := (r ->> 'lot_id')::uuid;
  v_lot     public.stock_lot%rowtype;
  v_unit    text;
  v_dim     text;
  v_sized   boolean;
  v_pack    numeric;
  v_have    numeric;
  v_out     numeric;
  v_take    numeric;
  v_from    uuid;
  v_rest    numeric;
  v_jars    integer;
  v_jar     public.location%rowtype;
  v_corr    uuid;
  v_base    jsonb;
  v_res     jsonb;
  v_item    uuid;
  v_ticked  jsonb;
  v_loc     uuid;
  v_today   date;
  v_bill    record;
  t         record;
begin
  v_base := jsonb_build_object('code_kind', v_kind);
  if p_mode is null or p_mode not in ('use', 'add', 'open', 'waste', 'check') then
    raise exception 'unknown mode' using errcode = '23514';
  end if;
  if (r ->> 'product_id') is null then
    return v_base || jsonb_build_object(
      'status', case when coalesce((r ->> 'linkable')::boolean, false) then 'unknown' else 'not_pantry' end);
  end if;

  v_product := private.stock_product(p_household, (r ->> 'product_id')::uuid);
  if v_product.archived and v_product.merged_into_id is not null then
    v_product := private.stock_product(p_household, v_product.merged_into_id);
  end if;
  select u.code, u.dimension into v_unit, v_dim from public.unit u where u.id = v_product.stock_unit_id;
  v_sized := v_dim in ('mass', 'volume');
  -- One pack: what the barcode says ("1 pack = 400 g"), else the product's quick amount.
  v_pack := case when r ? 'pack_qty'
                 then private.to_stock_qty(v_product.id, (r ->> 'pack_unit')::uuid, (r ->> 'pack_qty')::numeric)
                 else v_product.quick_consume_qty end;
  if v_pack is null or v_pack <= 0 then
    v_pack := 1;
  end if;
  v_base := v_base || jsonb_build_object('product_id', v_product.id, 'name', v_product.name, 'unit', v_unit,
                                         'sized', v_sized, 'pack', v_pack);
  v_have := private.bin_left(p_household, v_product.id);

  -- ── Check ──
  if p_mode = 'check' then
    return v_base || jsonb_build_object(
      'status', 'checked', 'left_qty', v_have, 'lot_id', v_lot_id,
      'due', (select min(l.due_date) from public.stock_lot l
               where l.household_id = p_household and l.product_id = v_product.id and l.qty_remaining > 0));
  end if;

  -- ── Add ──
  if p_mode = 'add' then
    if not coalesce(p_force, false) then
      select sum(k.qty_initial) as qty, max(k.purchased_on) as bought_on into v_bill
        from public.stock_lot k
       where k.household_id = p_household and k.product_id = v_product.id
         and k.transaction_line_id is not null and k.split_from_id is null
         and k.created_at > now() - interval '3 days';
      if v_bill.qty is not null then
        return v_base || jsonb_build_object('status', 'bill_guard', 'left_qty', v_have,
                                            'bill_qty', v_bill.qty, 'bill_on', v_bill.bought_on);
      end if;
    end if;
    v_corr := gen_random_uuid();
    v_loc := v_product.default_location_id;
    v_today := private.household_today(p_household);
    v_from := private.stock_new_lot(
      p_household, v_product.id, v_pack * v_count, v_loc, null, v_today,
      private.default_due(v_product, v_loc, v_today), null, null, null, 'purchase', v_corr, 'Bin scanner');
    -- It is in the house now: open list lines for it are done.
    with done as (
      update public.shopping_list_item i set done = true
       where i.household_id = p_household and i.product_id = v_product.id and not i.done and not i.dismissed
      returning i.id
    )
    select coalesce(jsonb_agg(d.id), '[]'::jsonb) into v_ticked from done d;
    return v_base || jsonb_build_object('status', 'added', 'lot_id', v_from, 'qty', v_pack * v_count,
                                        'left_qty', v_have + v_pack * v_count, 'ticked', v_ticked,
                                        'correlation_id', v_corr);
  end if;

  -- ── Opened ──
  if p_mode = 'open' then
    begin
      if v_lot_id is not null then
        v_res := private.stock_open_core(p_household, jsonb_build_object('lot_id', v_lot_id));
      else
        select * into v_lot from public.stock_lot l
         where l.household_id = p_household and l.product_id = v_product.id and l.qty_remaining > 0
           and l.opened_at is null
         order by l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
         limit 1;
        v_res := private.stock_open_core(p_household,
          case when v_lot.id is not null and v_lot.qty_remaining > v_pack
               then jsonb_build_object('product_id', v_product.id, 'qty', v_pack)
               else jsonb_build_object('product_id', v_product.id) end);
      end if;
    exception when sqlstate 'GDSTK' then
      return v_base || jsonb_build_object('status', 'nothing_to_open', 'left_qty', v_have);
    end;
    return v_base || jsonb_build_object(
      'status', 'opened', 'lot_id', v_res -> 'lot_id', 'qty', v_res -> 'qty', 'left_qty', v_have,
      'due', (select l.due_date from public.stock_lot l where l.id = (v_res ->> 'lot_id')::uuid),
      'correlation_id', v_res -> 'correlation_id');
  end if;

  -- ── Used / Waste ──
  if v_have <= 0 then
    if p_mode = 'use' then
      v_item := private.bin_list_add(p_household, v_product);
    end if;
    return v_base || jsonb_build_object(
      'status', 'no_stock', 'left_qty', 0, 'list_item_id', v_item,
      'on_list', exists (select 1 from public.shopping_list_item i
                          where i.household_id = p_household and i.product_id = v_product.id
                            and not i.done and not i.dismissed));
  end if;

  v_corr := gen_random_uuid();
  if v_lot_id is not null then
    -- A lot label: that pack is finished.
    select * into v_lot from public.stock_lot l where l.id = v_lot_id and l.household_id = p_household for update;
    if v_lot.qty_remaining <= 0 then
      return v_base || jsonb_build_object('status', 'no_stock', 'lot_id', v_lot_id, 'left_qty', v_have, 'on_list', false);
    end if;
    select * into t from private.stock_take(p_household, v_product.id, null, null, v_lot_id, case p_mode when 'waste' then 'waste' else 'consume' end,
                                            v_corr, 'Bin scanner');
  else
    if p_mode = 'use' then
      select count(*) into v_jars from public.location l
       where l.household_id = p_household and l.holds_product_id = v_product.id and l.tare_g is not null;
      if v_jars > 0 then
        -- Lives in a kitchen-scale jar: the scale counts the grams; the empty pack only says "poured in".
        select * into v_jar from public.location l
         where l.household_id = p_household and l.holds_product_id = v_product.id and l.tare_g is not null
         order by l.name, l.id limit 1;
        select coalesce(sum(l.qty_remaining), 0) into v_out from public.stock_lot l
         where l.household_id = p_household and l.product_id = v_product.id and l.qty_remaining > 0
           and (l.location_id is null or l.location_id not in (
                  select j.id from public.location j
                   where j.household_id = p_household and j.holds_product_id = v_product.id and j.tare_g is not null));
        if v_out <= 0 or v_jars > 1 then
          return v_base || jsonb_build_object('status', 'in_jar', 'left_qty', v_have,
                                              'jar', case when v_jars = 1 then v_jar.name end);
        end if;
        v_take := least(v_pack * v_count, v_out);
        v_res := private.stock_transfer_core(p_household,
          case when v_take >= v_out
               then jsonb_build_object('to_location_id', v_jar.id, 'product_id', v_product.id)
               else jsonb_build_object('to_location_id', v_jar.id, 'product_id', v_product.id, 'qty', v_take) end);
        return v_base || jsonb_build_object('status', 'moved', 'qty', v_res -> 'qty', 'left_qty', v_have,
                                            'jar', v_jar.name, 'correlation_id', v_res -> 'correlation_id');
      end if;
    end if;

    -- The pack in progress: the first lot in the app's order.
    select * into v_lot from public.stock_lot l
     where l.household_id = p_household and l.product_id = v_product.id and l.qty_remaining > 0
     order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
     limit 1
     for update;
    v_take := least(v_pack * v_count, v_have);
    v_from := null;
    if v_sized and v_count = 1 then
      if v_lot.opened_at is not null and v_lot.qty_remaining <= v_pack * 1.005 then
        v_take := null;                       -- the opened pack: all that is left in it
        v_from := v_lot.id;
      else
        v_rest := v_lot.qty_remaining - v_pack * floor(v_lot.qty_remaining / v_pack + 0.005);
        if v_rest > v_pack * 0.005 then
          v_take := v_rest;                   -- part of this pack was already taken: the rest goes
          v_from := v_lot.id;
        end if;
      end if;
    end if;
    select * into t from private.stock_take(p_household, v_product.id, v_take, null, v_from,
                                            case p_mode when 'waste' then 'waste' else 'consume' end, v_corr, 'Bin scanner');
  end if;

  v_have := private.bin_left(p_household, v_product.id);
  if v_have <= 0 and p_mode = 'use' then
    v_item := private.bin_list_add(p_household, v_product);
  end if;
  return v_base || jsonb_build_object(
    'status', case p_mode when 'waste' then 'wasted' else 'used' end,
    'lot_id', coalesce(v_lot_id, v_from), 'qty', -t.taken, 'left_qty', v_have, 'list_item_id', v_item,
    'on_list', exists (select 1 from public.shopping_list_item i
                        where i.household_id = p_household and i.product_id = v_product.id
                          and not i.done and not i.dismissed),
    'correlation_id', v_corr);
end;
$$;

-- ── Taking a scan back ────────────────────────────────────────────────────────
-- Returns { status: 'undo' | 'undo_none', reason?, name, left_qty, unit }. The stock goes back through
-- the undo core (refused when that stock has changed since); a shopping-list line the scan added
-- is removed, lines it ticked are open again; a scan still waiting for a person is dismissed.
create function private.bin_undo(p_scan public.bin_scan, p_by uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_base jsonb := jsonb_build_object('name', p_scan.result ->> 'name', 'unit', p_scan.result ->> 'unit',
                                     'product_id', p_scan.product_id, 'target_id', p_scan.id);
begin
  if p_scan.kind <> 'scan' or p_scan.undone_at is not null
     or p_scan.status in ('checked', 'in_jar', 'not_pantry', 'nothing_to_open', 'dismissed', 'error') then
    return v_base || jsonb_build_object('status', 'undo_none', 'reason', 'nothing');
  end if;

  if p_scan.status in ('unknown', 'bill_guard', 'held') then
    update public.bin_scan s set status = 'dismissed', undone_at = now(), undone_by = p_by where s.id = p_scan.id;
    return v_base || jsonb_build_object('status', 'undo');
  end if;

  if p_scan.correlation_id is not null then
    begin
      perform private.stock_undo_core(p_scan.correlation_id);
    exception when sqlstate 'GDUND' then
      return v_base || jsonb_build_object('status', 'undo_none', 'reason', 'changed');
    end;
  end if;
  if p_scan.list_item_id is not null then
    delete from public.shopping_list_item i
     where i.id = p_scan.list_item_id and i.household_id = p_scan.household_id and not i.done and i.source = 'scanner';
  end if;
  if jsonb_typeof(p_scan.result -> 'ticked') = 'array' then
    update public.shopping_list_item i set done = false
     where i.household_id = p_scan.household_id and i.done and i.done_by_line is null
       and i.id in (select (value #>> '{}')::uuid from jsonb_array_elements(p_scan.result -> 'ticked'));
  end if;
  update public.bin_scan s set undone_at = now(), undone_by = p_by where s.id = p_scan.id;
  return v_base || jsonb_build_object(
    'status', 'undo',
    'left_qty', case when p_scan.product_id is not null then private.bin_left(p_scan.household_id, p_scan.product_id) end);
end;
$$;

revoke execute on function private.stock_open_core(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.stock_undo_core(uuid) from public, anon, authenticated;
revoke execute on function private.bin_resolve(uuid, text) from public, anon, authenticated;
revoke execute on function private.bin_left(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.bin_list_add(uuid, public.product) from public, anon, authenticated;
revoke execute on function private.bin_apply(uuid, text, integer, text, boolean) from public, anon, authenticated;
revoke execute on function private.bin_undo(public.bin_scan, uuid) from public, anon, authenticated;

update public.app_meta set value = '107' where key = 'schema_version';
