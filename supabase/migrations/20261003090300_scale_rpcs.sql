-- Phase 6b · 65 — weighing a jar becomes stock movements (MASTER_PLAN §7b, replaced 2026-10-03)
-- The rule (Didula, 2026-10-03): a reading's net weight is compared with the jar's STOCK, not with the
-- last reading, so small uses add up and every weighing is also a stock count.
--   net − stock ≤ −threshold (2 g)  → used: consume from the jar's lots (FEFO)
--   |net − stock| < threshold       → no change (nothing recorded but the reading)
--   net − stock ≥ threshold         → refilled: move the difference from the product's other lots into
--                                     the jar; whatever can't be covered waits for a person
--                                     (needs_decision → Move from pantry / Count correction / Later)
-- All of it goes through stock_movement (rule 1). The device path (rpc_scale_sync) runs with the
-- service role after the Edge Function checked the token's hash, so the stock work lives in private
-- functions without the auth.uid() checks; the public RPCs keep their can_write checks.
-- rpc_transfer and rpc_inventory (migration 26) become thin wrappers around their bodies, unchanged.

-- ── Core of rpc_transfer, unchanged apart from the caller check ──────────────
create function private.stock_transfer_core(p_household uuid, p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid := p_household;
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

create or replace function public.rpc_transfer(p jsonb)
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
  return private.stock_transfer_core(v_household, p);
end;
$$;

-- ── Core of rpc_inventory, unchanged apart from the caller check ─────────────
create function private.stock_inventory_core(p_household uuid, p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid := p_household;
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

create or replace function public.rpc_inventory(p jsonb)
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
  return private.stock_inventory_core(v_household, p);
end;
$$;

-- ── Grams ↔ the product's stock unit ──────────────────────────────────────────
create function private.unit_g()
returns uuid
language sql
stable
set search_path = ''
as $$
  select u.id from public.unit u where u.household_id is null and u.code = 'g'
$$;

-- A quantity in the product's stock unit, in grams (GDUNT when the product isn't weighable).
create function private.stock_g(p_product uuid, p_qty numeric)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round(p_qty * 1000000 / private.to_stock_qty(p_product, private.unit_g(), 1000000), 4)
$$;

-- The product's stock in one place, in grams; `p_inside` false = everywhere else.
create function private.stock_g_at(p_household uuid, p_product uuid, p_location uuid, p_inside boolean)
returns numeric
language sql
stable
set search_path = ''
as $$
  select private.stock_g(p_product, coalesce(sum(l.qty_remaining), 0))
    from public.stock_lot l
   where l.household_id = p_household and l.product_id = p_product and l.qty_remaining > 0
     and case when p_inside then l.location_id = p_location else l.location_id is distinct from p_location end
$$;

-- Move up to p_g grams of the product from anywhere else into the jar. Returns {correlation_id, moved_g}.
create function private.scale_move_in(p_household uuid, p_product uuid, p_location uuid, p_g numeric)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_other_g numeric := private.stock_g_at(p_household, p_product, p_location, false);
  v_res     jsonb;
begin
  if v_other_g <= 0 or p_g <= 0 then
    return jsonb_build_object('correlation_id', null, 'moved_g', 0);
  end if;
  -- Everything that's left elsewhere moves without a quantity, so rounding can't ask for 0.0001 too much.
  v_res := private.stock_transfer_core(p_household,
    case when p_g >= v_other_g
         then jsonb_build_object('to_location_id', p_location, 'product_id', p_product)
         else jsonb_build_object('to_location_id', p_location, 'product_id', p_product,
                                 'qty', p_g, 'unit_id', private.unit_g()) end);
  return jsonb_build_object('correlation_id', v_res -> 'correlation_id',
                            'moved_g', private.stock_g(p_product, (v_res ->> 'qty')::numeric));
end;
$$;

-- ── The weighing rule ─────────────────────────────────────────────────────────
-- Returns { status, location_id, container, product_id, name, net_g, stock_before_g, delta_g,
--           moved_g, pending_g, left_g, correlation_id }.
create function private.scale_apply(p_household uuid, p_location uuid, p_net_g numeric, p_at timestamptz,
                                    p_threshold numeric)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_loc      public.location%rowtype;
  v_product  public.product%rowtype;
  v_stock    numeric;
  v_stock_g  numeric;
  v_net      numeric;
  v_delta    numeric;
  v_last     timestamptz;
  v_last_read timestamptz;
  v_corr     uuid;
  v_moved    numeric := 0;
  v_pending  numeric := 0;
  v_status   text;
  v_take     numeric;
  v_in       jsonb;
  r          record;
  v_base     jsonb;
begin
  select * into v_loc from public.location l where l.id = p_location and l.household_id = p_household for update;
  if not found then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  v_base := jsonb_build_object('location_id', v_loc.id, 'container', v_loc.name, 'net_g', round(p_net_g, 1));
  if v_loc.holds_product_id is null then
    return v_base || jsonb_build_object('status', 'no_product');
  end if;
  v_product := private.stock_product(p_household, v_loc.holds_product_id);
  v_base := v_base || jsonb_build_object('product_id', v_product.id, 'name', v_product.name);

  perform 1 from public.stock_lot l
   where l.household_id = p_household and l.product_id = v_product.id and l.location_id = p_location
     and l.qty_remaining > 0
   order by l.opened_at is null, l.due_date nulls last, l.purchased_on nulls last, l.created_at, l.id
   for update;
  select coalesce(sum(l.qty_remaining), 0) into v_stock from public.stock_lot l
   where l.household_id = p_household and l.product_id = v_product.id and l.location_id = p_location
     and l.qty_remaining > 0;
  v_stock_g := private.stock_g(v_product.id, v_stock);
  v_base := v_base || jsonb_build_object('stock_before_g', round(v_stock_g, 1));

  -- A reading older than the jar's latest change (queued offline) only records what it saw: a weight
  -- is an absolute count, so the next weighing corrects things anyway. "Latest change" = a later
  -- weighing of this jar, or a stock movement in it that no weighing made (app, bill, undo); the
  -- scale's own movements carry the server's time, not the weighing's, so they don't count.
  select max(m.created_at) into v_last from public.stock_movement m
   where m.household_id = p_household and m.product_id = v_product.id and m.location_id = p_location
     and not exists (select 1 from public.scale_reading s
                      where s.household_id = p_household and s.correlation_id = m.correlation_id);
  select max(s.at) into v_last_read from public.scale_reading s
   where s.household_id = p_household and s.location_id = p_location
     and s.status in ('consumed', 'no_change', 'refilled', 'needs_decision', 'decided');
  if (v_last is not null and p_at < v_last - interval '5 seconds') or p_at < v_last_read then
    return v_base || jsonb_build_object('status', 'superseded', 'left_g', round(v_stock_g, 1));
  end if;

  if p_net_g < -5 then
    return v_base || jsonb_build_object('status', 'below_tare', 'left_g', round(v_stock_g, 1));
  end if;

  -- A newer weighing replaces any earlier question about this jar.
  update public.scale_reading s set status = 'superseded'
   where s.household_id = p_household and s.location_id = p_location and s.status = 'needs_decision';

  v_net := greatest(p_net_g, 0);
  v_delta := v_net - v_stock_g;

  if abs(v_delta) < p_threshold then
    v_status := 'no_change';
  elsif v_delta < 0 then
    v_corr := gen_random_uuid();
    -- Practically empty: take everything, so no 0.3 g ghost stays in the jar.
    v_take := case when v_net < p_threshold then null
                   else least(private.to_stock_qty(v_product.id, private.unit_g(), -v_delta), v_stock) end;
    select * into r from private.stock_take(p_household, v_product.id, v_take, p_location, null, 'consume', v_corr,
                                            'Kitchen scale');
    v_moved := -private.stock_g(v_product.id, r.taken);
    v_status := 'consumed';
  else
    v_in := private.scale_move_in(p_household, v_product.id, p_location, v_delta);
    v_corr := (v_in ->> 'correlation_id')::uuid;
    v_moved := (v_in ->> 'moved_g')::numeric;
    v_pending := v_delta - v_moved;
    if v_pending >= p_threshold then
      v_status := 'needs_decision';
    else
      v_status := 'refilled';
      v_pending := 0;
    end if;
  end if;

  return v_base || jsonb_build_object(
    'status', v_status, 'delta_g', round(v_delta, 1), 'moved_g', round(v_moved, 1), 'pending_g', round(v_pending, 1),
    'left_g', round(private.stock_g_at(p_household, v_product.id, p_location, true), 1),
    'correlation_id', v_corr);
end;
$$;

-- One stable weighing from a scale: find the jar by its tag (or link the tag), then apply the rule.
create function private.scale_event(p_household uuid, p_threshold numeric, p_uid text, p_ndef text,
                                    p_gross numeric, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tag    public.nfc_tag%rowtype;
  v_loc    public.location%rowtype;
  v_linked boolean := false;
  v_base   jsonb := jsonb_build_object('uid', p_uid, 'gross_g', round(p_gross, 1));
begin
  if p_uid is null then
    return v_base || jsonb_build_object('status', 'no_tag');
  end if;

  select * into v_tag from public.nfc_tag t where t.household_id = p_household and t.uid = p_uid for update;
  if found then
    update public.nfc_tag t set last_seen_at = now() where t.id = v_tag.id;
    select * into v_loc from public.location l where l.id = v_tag.location_id for update;
  else
    -- "Weigh empty" armed for a container that has no tag yet → this is its tag.
    select * into v_loc from public.location l
     where l.household_id = p_household and l.scale_setup_until > now()
       and not exists (select 1 from public.nfc_tag t where t.household_id = l.household_id and t.location_id = l.id)
     order by l.scale_setup_until desc
     limit 1
     for update;
    -- The tag was written on a phone (NDEF URL with the jar's code) but its UID isn't linked yet.
    if v_loc.id is null and p_ndef is not null then
      select * into v_loc from public.location l
       where l.household_id = p_household and l.code = upper(p_ndef)
       for update;
    end if;
    if v_loc.id is null then
      return v_base || jsonb_build_object('status', 'unknown_tag');
    end if;
    perform private.nfc_link(p_household, p_uid, v_loc.id, false);
    v_linked := true;
  end if;

  v_base := v_base || jsonb_build_object('linked', v_linked, 'location_id', v_loc.id, 'container', v_loc.name,
                                         'product_id', v_loc.holds_product_id,
                                         'name', (select p.name from public.product p where p.id = v_loc.holds_product_id));

  if v_loc.scale_setup_until > now() then
    update public.location l set tare_g = round(greatest(p_gross, 0), 1), scale_setup_until = null where l.id = v_loc.id;
    return v_base || jsonb_build_object('status', 'tare_set', 'tare_g', round(greatest(p_gross, 0), 1));
  end if;
  if v_loc.tare_g is null then
    return v_base || jsonb_build_object('status', 'no_tare');
  end if;
  return v_base || jsonb_build_object('tare_g', v_loc.tare_g)
         || private.scale_apply(p_household, v_loc.id, p_gross - v_loc.tare_g, p_at, p_threshold);
end;
$$;

-- Store one reading (device or app) from its result object.
create function private.scale_store(p_household uuid, p_device uuid, p_epoch bigint, p_seq bigint, p_op uuid,
                                    p_at timestamptz, p_estimated boolean, p_res jsonb, p_error text)
returns void
language sql
set search_path = ''
as $$
  insert into public.scale_reading
    (household_id, device_id, epoch, seq, op_id, at, time_estimated, uid, location_id, product_id,
     gross_g, tare_g, net_g, stock_before_g, delta_g, moved_g, pending_g, status, correlation_id, error_code, result)
  values
    (p_household, p_device, p_epoch, p_seq, p_op, p_at, p_estimated, p_res ->> 'uid',
     (p_res ->> 'location_id')::uuid, (p_res ->> 'product_id')::uuid,
     (p_res ->> 'gross_g')::numeric, (p_res ->> 'tare_g')::numeric, (p_res ->> 'net_g')::numeric,
     (p_res ->> 'stock_before_g')::numeric, (p_res ->> 'delta_g')::numeric, (p_res ->> 'moved_g')::numeric,
     (p_res ->> 'pending_g')::numeric, p_res ->> 'status', (p_res ->> 'correlation_id')::uuid, p_error, p_res)
$$;

revoke execute on function private.stock_transfer_core(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.stock_inventory_core(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.unit_g() from public, anon, authenticated;
revoke execute on function private.stock_g(uuid, numeric) from public, anon, authenticated;
revoke execute on function private.stock_g_at(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function private.scale_move_in(uuid, uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function private.scale_apply(uuid, uuid, numeric, timestamptz, numeric) from public, anon, authenticated;
revoke execute on function private.scale_event(uuid, numeric, text, text, numeric, timestamptz) from public, anon, authenticated;
revoke execute on function private.scale_store(uuid, uuid, bigint, bigint, uuid, timestamptz, boolean, jsonb, text)
  from public, anon, authenticated;

-- ── rpc_scale_sync: everything a scale says and hears, in one round trip ──────
-- Called only by the scale-ingest Edge Function (service role) with sha256(token). p is the
-- device's request, already validated by Zod there (docs/kitchen-scale/protocol.md):
--   { v, fw, epoch, boot, up, status{}, events[{seq, b, t, at?, type, uid?, ndef?, gross_g}],
--     live?{state, uid?, gross_g?}, done[{id, ok, result?}], containers_v? }
create function public.rpc_scale_sync(p_token_hash text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev      public.device%rowtype;
  v_epoch    bigint := (p ->> 'epoch')::bigint;
  v_boot     bigint := (p ->> 'boot')::bigint;
  v_up       bigint := (p ->> 'up')::bigint;
  v_floor    bigint;
  v_events   jsonb := coalesce(p -> 'events', '[]'::jsonb);
  v_e        jsonb;
  v_seq      bigint;
  v_at       timestamptz;
  v_at_dev   timestamptz;
  v_est      boolean;
  v_res      jsonb;
  v_err      text;
  v_old      jsonb;
  v_acked    jsonb := '[]'::jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_new      integer := 0;
  v_cmd      text;
  v_cmds     jsonb;
  v_cv       text;
  v_items    jsonb;
  v_tz       text;
  v_threshold numeric;
begin
  select d.* into v_dev from public.device_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null
   for update of d;
  if not found then
    raise exception 'unknown or revoked device' using errcode = '42501';
  end if;
  if jsonb_typeof(v_events) <> 'array' or jsonb_array_length(v_events) > 20 then
    raise exception 'at most 20 events' using errcode = '23514';
  end if;
  if (select count(*) from public.scale_reading s
       where s.device_id = v_dev.id and s.received_at > now() - interval '10 minutes')
     + jsonb_array_length(v_events) > 600 then
    raise exception 'too many readings' using errcode = 'GDRTE';
  end if;

  -- A new epoch means the device's flash was erased: its numbering starts again.
  v_floor := case when v_dev.epoch is not distinct from v_epoch then v_dev.seq_floor else 0 end;
  update public.device d set
    last_seen_at = now(),
    fw_version = left(p ->> 'fw', 32),
    epoch = v_epoch,
    seq_floor = v_floor,
    status = coalesce(p -> 'status', '{}'::jsonb) || jsonb_build_object('boot', v_boot, 'up', v_up),
    live_state = case when p ? 'live' then p -> 'live' ->> 'state' else d.live_state end,
    live_uid = case when p ? 'live' then private.nfc_uid(p -> 'live' ->> 'uid') else d.live_uid end,
    live_gross_g = case when p ? 'live' then (p -> 'live' ->> 'gross_g')::numeric else d.live_gross_g end,
    live_at = case when p ? 'live' then now() else d.live_at end
   where d.id = v_dev.id;

  -- Commands the device finished.
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'done', '[]'::jsonb)) loop
    v_cmd := null;
    update public.device_command c set
      status = case when (v_e ->> 'ok')::boolean then 'done' else 'failed' end,
      result = case when jsonb_typeof(v_e -> 'result') = 'object' then v_e -> 'result' end,
      done_at = now()
     where c.id = (v_e ->> 'id')::uuid and c.device_id = v_dev.id and c.status in ('queued', 'sent')
     returning c.command into v_cmd;
    if v_cmd = 'calibrate' and (v_e ->> 'ok')::boolean then
      update public.device d set calibrated_at = now() where d.id = v_dev.id;
    end if;
  end loop;

  -- Readings, in the device's order. A replay returns what was decided the first time.
  v_threshold := coalesce((v_dev.settings ->> 'threshold_g')::numeric, 2);
  for v_e in select value from jsonb_array_elements(v_events) order by (value ->> 'seq')::bigint loop
    v_seq := (v_e ->> 'seq')::bigint;
    if v_seq <= v_floor then
      v_acked := v_acked || to_jsonb(v_seq);
      v_results := v_results || jsonb_build_object('seq', v_seq, 'status', 'pruned', 'replayed', true);
      continue;
    end if;
    select s.result into v_old from public.scale_reading s
     where s.device_id = v_dev.id and s.epoch = v_epoch and s.seq = v_seq;
    if found then
      v_acked := v_acked || to_jsonb(v_seq);
      v_results := v_results || (v_old || jsonb_build_object('seq', v_seq, 'replayed', true));
      continue;
    end if;

    -- When was it weighed? The device's clock if plausible, else estimated from its uptime.
    v_at_dev := case when v_e ? 'at' then to_timestamp((v_e ->> 'at')::numeric / 1000) end;
    if v_at_dev between now() - interval '30 days' and now() + interval '60 seconds' then
      v_at := least(v_at_dev, now());
      v_est := false;
    elsif (v_e ->> 'b')::bigint = v_boot and (v_e ->> 't')::bigint <= v_up then
      v_at := now() - make_interval(secs => (v_up - (v_e ->> 't')::bigint) / 1000.0);
      v_est := true;
    else
      v_at := now();
      v_est := true;
    end if;

    begin
      v_res := private.scale_event(v_dev.household_id, v_threshold, private.nfc_uid(v_e ->> 'uid'),
                                   nullif(v_e ->> 'ndef', ''), (v_e ->> 'gross_g')::numeric, v_at);
      v_err := null;
    exception when others then
      -- Stored and acked anyway, so one bad reading can never block the device's queue.
      v_res := jsonb_build_object('status', 'error', 'uid', private.nfc_uid(v_e ->> 'uid'), 'error', sqlstate);
      v_err := sqlstate;
    end;
    perform private.scale_store(v_dev.household_id, v_dev.id, v_epoch, v_seq, null, v_at, v_est, v_res, v_err);
    v_new := v_new + 1;
    v_acked := v_acked || to_jsonb(v_seq);
    v_results := v_results || (v_res || jsonb_build_object('seq', v_seq));
  end loop;
  if v_new > 0 then
    update public.device d set reading_count = d.reading_count + v_new where d.id = v_dev.id;
  end if;

  -- Commands to run: old ones expire; queued and unconfirmed ones are (re)sent until done.
  update public.device_command c set status = 'expired'
   where c.device_id = v_dev.id and c.status in ('queued', 'sent') and c.created_at < now() - interval '10 minutes';
  with sent as (
    update public.device_command c set status = 'sent', sent_at = coalesce(c.sent_at, now())
     where c.device_id = v_dev.id and c.status in ('queued', 'sent')
    returning c.id, c.command, c.args, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'command', s.command, 'args',
           case when s.command = 'ota' then
             coalesce((select jsonb_build_object('version', f.version, 'sha256', f.sha256, 'size', f.size, 'path', f.path)
                         from public.device_firmware f
                        where f.id = (s.args ->> 'firmware_id')::uuid and f.household_id = v_dev.household_id), '{}'::jsonb)
           else s.args end) order by s.created_at), '[]'::jsonb)
    into v_cmds from sent s;

  -- Containers the device may meet (tag → name, empty weight), resent only when they change.
  select coalesce(left(md5(string_agg(t.uid || '|' || coalesce(l.tare_g::text, '') || '|' || l.name || '|'
                                      || coalesce(p2.name, ''), ',' order by t.uid)), 8), '0')
    into v_cv
    from public.nfc_tag t
    join public.location l on l.id = t.location_id
    left join public.product p2 on p2.id = l.holds_product_id
   where t.household_id = v_dev.household_id;
  if (p ->> 'containers_v') is distinct from v_cv then
    select coalesce(jsonb_agg(jsonb_build_object(
             'uid', t.uid,
             'name', case when p2.name ~ '^[ -~]+$' then left(p2.name, 21)
                          when l.name ~ '^[ -~]+$' then left(l.name, 21) else 'Container' end,
             'tare_g', l.tare_g,
             'holds', l.holds_product_id is not null) order by t.uid), '[]'::jsonb)
      into v_items
      from (select * from public.nfc_tag t0 where t0.household_id = v_dev.household_id order by t0.last_seen_at desc nulls last
            limit 200) t
      join public.location l on l.id = t.location_id
      left join public.product p2 on p2.id = l.holds_product_id;
  end if;

  select h.timezone into v_tz from public.household h where h.id = v_dev.household_id;

  return jsonb_build_object(
    'acked', v_acked,
    'results', v_results,
    'commands', v_cmds,
    'config', v_dev.settings || jsonb_build_object(
                'v', v_dev.settings_version,
                'tz_offset_min', round(extract(epoch from (now() at time zone coalesce(v_tz, 'Asia/Colombo'))
                                                        - (now() at time zone 'UTC')) / 60)),
    'containers', jsonb_build_object('v', v_cv) || case when v_items is not null then jsonb_build_object('items', v_items)
                                                       else '{}'::jsonb end,
    'poll_ms', case when v_dev.watch_until > now() or jsonb_array_length(v_cmds) > 0 then 1000 else 30000 end,
    'server_time', round(extract(epoch from now()) * 1000));
end;
$$;

revoke execute on function public.rpc_scale_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_scale_sync(text, jsonb) to service_role;

-- ── rpc_weigh: a weight typed in the app (another scale), or a test ───────────
-- Idempotent by op id like rpc_stock_op: a replay returns the first result with replayed = true.
create function public.rpc_weigh(p_op_id uuid, p_location uuid, p_net_g numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_done      jsonb;
  v_res       jsonb;
begin
  select l.household_id into v_household from public.location l where l.id = p_location;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_op_id is null then
    raise exception 'op_id is required' using errcode = '23514';
  end if;
  if p_net_g is null or p_net_g < 0 or p_net_g > 100000 then
    raise exception 'weight must be between 0 and 100 kg' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_household::text || ':weigh:' || p_op_id::text, 0));
  select s.result into v_done from public.scale_reading s where s.household_id = v_household and s.op_id = p_op_id;
  if found then
    return v_done || jsonb_build_object('replayed', true);
  end if;
  v_res := private.scale_apply(v_household, p_location, p_net_g, now(), 2);
  perform private.scale_store(v_household, null, null, null, p_op_id, now(), false, v_res, null);
  return v_res;
end;
$$;

-- ── rpc_scale_decide: the heavier jar that nothing could be moved from ─────────
-- p_choice: 'transfer' (move from the pantry now) · 'adjust' (count correction) · 'later'.
create function public.rpc_scale_decide(p_reading uuid, p_choice text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.scale_reading%rowtype;
  v_in      jsonb;
  v_inv     jsonb;
  v_moved   numeric := 0;
  v_pending numeric;
  v_corr    uuid;
  v_status  text;
  v_stock   numeric;
begin
  select * into v_r from public.scale_reading s where s.id = p_reading for update;
  if not found or not private.can_write(v_r.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_choice is null or p_choice not in ('transfer', 'adjust', 'later') then
    raise exception 'unknown choice' using errcode = '23514';
  end if;
  if v_r.status <> 'needs_decision' or v_r.location_id is null or v_r.product_id is null then
    raise exception 'already decided' using errcode = 'GDDEC';
  end if;

  if p_choice = 'later' then
    update public.scale_reading s set decision = coalesce(s.decision, '{}'::jsonb) || jsonb_build_object('later_at', now())
     where s.id = p_reading;
    return jsonb_build_object('status', 'needs_decision', 'pending_g', v_r.pending_g, 'correlation_id', null);
  end if;

  perform 1 from public.location l where l.id = v_r.location_id for update;
  v_pending := v_r.pending_g;
  if p_choice = 'transfer' then
    v_in := private.scale_move_in(v_r.household_id, v_r.product_id, v_r.location_id, v_pending);
    v_moved := (v_in ->> 'moved_g')::numeric;
    if v_moved <= 0 then
      raise exception 'nothing of this product is left elsewhere' using errcode = 'GDSTK', detail = '0';
    end if;
    v_corr := (v_in ->> 'correlation_id')::uuid;
    v_pending := greatest(v_pending - v_moved, 0);
  else
    select coalesce(sum(l.qty_remaining), 0) into v_stock from public.stock_lot l
     where l.household_id = v_r.household_id and l.product_id = v_r.product_id and l.location_id = v_r.location_id
       and l.qty_remaining > 0;
    v_inv := private.stock_inventory_core(v_r.household_id, jsonb_build_object(
      'product_id', v_r.product_id, 'location_id', v_r.location_id,
      'qty', v_stock + private.to_stock_qty(v_r.product_id, private.unit_g(), v_pending), 'note', 'Kitchen scale'));
    v_corr := (v_inv ->> 'correlation_id')::uuid;
    v_moved := v_pending;
    v_pending := 0;
  end if;

  v_status := case when v_pending >= 2 then 'needs_decision' else 'decided' end;
  update public.scale_reading s set
    status = v_status,
    pending_g = round(v_pending, 1),
    decision = coalesce(s.decision, '{}'::jsonb) || jsonb_build_object(
                 'choice', p_choice, 'correlation_id', v_corr, 'moved_g', round(v_moved, 1), 'at', now()),
    decided_by = auth.uid(),
    decided_at = now()
   where s.id = p_reading;
  return jsonb_build_object('status', v_status, 'pending_g', round(v_pending, 1), 'moved_g', round(v_moved, 1),
                            'correlation_id', v_corr,
                            'left_g', round(private.stock_g_at(v_r.household_id, v_r.product_id, v_r.location_id, true), 1));
end;
$$;

-- ── rpc_device_command ────────────────────────────────────────────────────────
-- tare · beep · identify · calibrate {known_g} (members); reboot · ota {firmware_id} (owner).
create function public.rpc_device_command(p_device uuid, p_command text, p_args jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev  public.device%rowtype;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_id   uuid;
begin
  select * into v_dev from public.device d where d.id = p_device and d.revoked_at is null for update;
  if not found or not private.can_write(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_command is null or p_command not in ('tare', 'calibrate', 'beep', 'identify', 'reboot', 'ota') then
    raise exception 'unknown command' using errcode = '23514';
  end if;
  if p_command in ('reboot', 'ota') and not private.is_owner(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_command = 'calibrate' then
    if jsonb_typeof(v_args -> 'known_g') <> 'number' or (v_args ->> 'known_g')::numeric not between 50 and 5000 then
      raise exception 'known weight must be 50 g to 5 kg' using errcode = '23514';
    end if;
    v_args := jsonb_build_object('known_g', round((v_args ->> 'known_g')::numeric, 1));
  elsif p_command = 'ota' then
    if not exists (select 1 from public.device_firmware f
                    where f.id = (v_args ->> 'firmware_id')::uuid and f.household_id = v_dev.household_id) then
      raise exception 'unknown firmware' using errcode = '23503';
    end if;
    v_args := jsonb_build_object('firmware_id', v_args ->> 'firmware_id');
  else
    v_args := '{}'::jsonb;
  end if;

  -- One of each at a time: a newer request replaces an older one still waiting.
  update public.device_command c set status = 'expired'
   where c.device_id = p_device and c.command = p_command and c.status in ('queued', 'sent');
  insert into public.device_command (household_id, device_id, command, args)
  values (v_dev.household_id, p_device, p_command, v_args)
  returning id into v_id;
  update public.device d set watch_until = greatest(coalesce(d.watch_until, now()), now() + interval '2 minutes')
   where d.id = p_device;
  return v_id;
end;
$$;

-- ── rpc_container_setup: "Weigh empty" — the next reading of this jar is its tare ──
create function public.rpc_container_setup(p_location uuid, p_on boolean default true)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_until     timestamptz := case when coalesce(p_on, true) then now() + interval '5 minutes' end;
begin
  select l.household_id into v_household from public.location l where l.id = p_location;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- One jar at a time: a new tag on the scale must not be guessed between two.
  update public.location l set scale_setup_until = null
   where l.household_id = v_household and l.scale_setup_until is not null and l.id <> p_location;
  update public.location l set scale_setup_until = v_until where l.id = p_location;
  return v_until;
end;
$$;

revoke execute on function public.rpc_weigh(uuid, uuid, numeric) from public, anon;
revoke execute on function public.rpc_scale_decide(uuid, text) from public, anon;
revoke execute on function public.rpc_device_command(uuid, text, jsonb) from public, anon;
revoke execute on function public.rpc_container_setup(uuid, boolean) from public, anon;
grant execute on function public.rpc_weigh(uuid, uuid, numeric) to authenticated;
grant execute on function public.rpc_scale_decide(uuid, text) to authenticated;
grant execute on function public.rpc_device_command(uuid, text, jsonb) to authenticated;
grant execute on function public.rpc_container_setup(uuid, boolean) to authenticated;

update public.app_meta set value = '65' where key = 'schema_version';
