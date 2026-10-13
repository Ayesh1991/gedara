-- Phase 7f · 69 — merge two products into one (decisions 2026-10-13)
-- One generic product per jar content ("Mustard seeds"); brand duplicates made by bills ("Freelan
-- Mustard Seeds") are merged into it so the kitchen scale can refill the jar from all of its stock.
-- rpc_product_merge moves everything that points at the source product to the target in one
-- transaction and archives the source with `merged_into_id` (its HL:PRD label then shows the way).
--
-- Stock follows rule 1:
--   * same stock unit  → lots and journal rows are re-pointed (product_id only; no quantity changes),
--                        so the whole history and the prices move with them;
--   * other unit that converts (pack → g, kg → g) → each lot with stock is moved by a transfer_out on
--                        the old lot and a new lot (transfer_in) in the target's unit; the old, empty
--                        history stays on the archived product;
--   * no conversion    → GDUNT and nothing changes.
-- A merge can't be undone (the dialog says so), and rpc_undo refuses its transfer movements.
--
-- Error codes: 42501 not allowed · 23503 unknown product · GDUNT units don't convert ·
--   GDMRG can't merge these two (DETAIL: same · archived · variant)

alter table public.product add column merged_into_id uuid;
alter table public.product
  add constraint product_merged_into_fk foreign key (household_id, merged_into_id)
    references public.product (household_id, id) on delete set null (merged_into_id);
create index product_merged_into_idx on public.product (household_id, merged_into_id) where merged_into_id is not null;
-- Not in any column grant: only the merge RPC sets it.

-- ── The journal stays append-only; the merge may only re-point it ─────────────
-- Same as migration 25, plus: rpc_product_merge (which sets gedara.merge_into for its transaction)
-- may change product_id, and nothing else, to the product being merged into.
create or replace function private.stock_movement_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_id is null and (to_jsonb(new) - 'location_id') = (to_jsonb(old) - 'location_id') then
    return new;
  end if;
  if new.product_id::text = nullif(current_setting('gedara.merge_into', true), '')
     and (to_jsonb(new) - 'product_id') = (to_jsonb(old) - 'product_id') then
    return new;
  end if;
  raise exception 'the stock journal is append-only' using errcode = '42501';
end;
$$;

-- ── 1 stock unit of the source = N stock units of the target ─────────────────
-- Same idea as private.to_stock_qty (same dimension, then product conversions in either direction),
-- but unrounded and looking at both products' conversions (the target's first).
create function private.merge_factor(p_source uuid, p_target uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_src  uuid := (select p.stock_unit_id from public.product p where p.id = p_source);
  v_tgt  uuid := (select p.stock_unit_id from public.product p where p.id = p_target);
  v_f    numeric;
  v_a    numeric;
  v_b    numeric;
  c      public.product_unit_conversion%rowtype;
begin
  v_f := private.unit_factor(v_src, v_tgt);
  if v_f is not null then
    return v_f;
  end if;
  for c in
    select x.* from public.product_unit_conversion x
     where x.product_id in (p_source, p_target)
     order by (x.product_id = p_target) desc, x.created_at
  loop
    -- 1 from = factor × to
    v_a := private.unit_factor(v_src, c.from_unit_id);
    v_b := private.unit_factor(c.to_unit_id, v_tgt);
    if v_a is not null and v_b is not null then
      return v_a * c.factor * v_b;
    end if;
    v_a := private.unit_factor(v_src, c.to_unit_id);
    v_b := private.unit_factor(c.from_unit_id, v_tgt);
    if v_a is not null and v_b is not null then
      return v_a / c.factor * v_b;
    end if;
  end loop;
  raise exception 'these products are counted in units that don''t convert' using errcode = 'GDUNT';
end;
$$;

revoke execute on function private.merge_factor(uuid, uuid) from public, anon, authenticated;

-- ── rpc_product_merge ─────────────────────────────────────────────────────────
-- Returns what moved: { mode: 'repoint'|'convert', factor, lots, movements, lines, aliases, barcodes,
-- conversions, list_items, containers, labels, readings, variants }.
create function public.rpc_product_merge(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src     public.product%rowtype;
  v_tgt     public.product%rowtype;
  v_h       uuid;
  v_factor  numeric;
  v_mode    text;
  v_corr    uuid := gen_random_uuid();
  v_lot     public.stock_lot%rowtype;
  v_new     uuid;
  v_n       integer;
  v_alias   text;
  v_out     jsonb := '{}'::jsonb;
begin
  -- Lock both (id order, so two merges the other way round can't deadlock).
  perform 1 from public.product p where p.id in (p_source, p_target) order by p.id for update;
  select * into v_src from public.product p where p.id = p_source;
  select * into v_tgt from public.product p where p.id = p_target;
  if v_src.id is null or v_tgt.id is null or not private.is_member(v_src.household_id)
     or v_tgt.household_id <> v_src.household_id then
    raise exception 'unknown product' using errcode = '23503';
  end if;
  v_h := v_src.household_id;
  if not private.can_write(v_h) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_src.id = v_tgt.id then
    raise exception 'a product can''t be merged into itself' using errcode = 'GDMRG', detail = 'same';
  end if;
  if v_tgt.archived or v_src.merged_into_id is not null then
    raise exception 'archived products can''t be merged' using errcode = 'GDMRG', detail = 'archived';
  end if;
  if v_tgt.parent_id = v_src.id
     or (v_tgt.parent_id is not null
         and exists (select 1 from public.product c where c.household_id = v_h and c.parent_id = v_src.id)) then
    raise exception 'sub-products can''t be merged this way' using errcode = 'GDMRG', detail = 'variant';
  end if;

  v_factor := private.merge_factor(v_src.id, v_tgt.id);   -- GDUNT before anything moves
  v_mode := case when v_src.stock_unit_id = v_tgt.stock_unit_id then 'repoint' else 'convert' end;

  -- Lots in a fixed order, so a scale or phone using one at the same time waits for us.
  perform 1 from public.stock_lot l where l.household_id = v_h and l.product_id = v_src.id order by l.id for update;

  -- ── Stock ──
  if v_mode = 'repoint' then
    perform set_config('gedara.merge_into', v_tgt.id::text, true);
    update public.stock_movement m set product_id = v_tgt.id
     where m.household_id = v_h and m.product_id = v_src.id;
    get diagnostics v_n = row_count;
    perform set_config('gedara.merge_into', '', true);
    v_out := v_out || jsonb_build_object('movements', v_n);
    update public.stock_lot l set product_id = v_tgt.id
     where l.household_id = v_h and l.product_id = v_src.id;
    get diagnostics v_n = row_count;
    v_out := v_out || jsonb_build_object('lots', v_n);
  else
    v_n := 0;
    for v_lot in
      select l.* from public.stock_lot l
       where l.household_id = v_h and l.product_id = v_src.id and l.qty_remaining > 0
       order by l.id
    loop
      insert into public.stock_movement
        (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, meta, note)
      values
        (v_h, v_lot.id, v_src.id, -v_lot.qty_remaining, 'transfer_out', v_lot.location_id, v_lot.unit_cost, v_corr,
         jsonb_build_object('merged_into', v_tgt.id), 'merged');
      -- The new lot keeps the bill line, so the price paid shows on the target (per its unit).
      insert into public.stock_lot
        (household_id, product_id, location_id, qty_initial, unit_cost, purchased_on, due_date, opened_at,
         transaction_line_id, note)
      values
        (v_h, v_tgt.id, v_lot.location_id, round(v_lot.qty_remaining * v_factor, 4),
         case when v_lot.unit_cost is null then null else round(v_lot.unit_cost / v_factor, 4) end,
         v_lot.purchased_on, v_lot.due_date, v_lot.opened_at, v_lot.transaction_line_id, v_lot.note)
      returning id into v_new;
      insert into public.stock_movement
        (household_id, lot_id, product_id, delta, reason, location_id, unit_cost, correlation_id, meta, note)
      select v_h, l.id, v_tgt.id, l.qty_initial, 'transfer_in', l.location_id, l.unit_cost, v_corr,
             jsonb_build_object('merged_from', v_src.id), 'merged'
        from public.stock_lot l where l.id = v_new;
      v_n := v_n + 1;
    end loop;
    v_out := v_out || jsonb_build_object('lots', v_n, 'movements', 0);
  end if;

  -- ── Bill lines (their own qty/unit stay as printed) ──
  update public.transaction_line t set product_id = v_tgt.id
   where t.household_id = v_h and t.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('lines', v_n);

  -- ── Learned bill names, plus the old product's own name ──
  update public.product_alias a set product_id = v_tgt.id
   where a.household_id = v_h and a.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_alias := private.bill_name_norm(v_src.name);
  if length(v_alias) between 1 and 200 then
    insert into public.product_alias (household_id, alias_norm, destiny, product_id)
    values (v_h, v_alias, 'stock', v_tgt.id)
    on conflict (household_id, alias_norm) do nothing;
  end if;
  v_out := v_out || jsonb_build_object('aliases', v_n);

  -- ── Barcodes: "1 scan = 1 stock unit" must keep meaning one of the OLD unit ──
  update public.product_barcode b
     set product_id = v_tgt.id,
         unit_id = case when v_mode = 'convert' then coalesce(b.unit_id, v_src.stock_unit_id) else b.unit_id end
   where b.household_id = v_h and b.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('barcodes', v_n);

  -- ── Pack sizes the target doesn't have yet ──
  update public.product_unit_conversion c set product_id = v_tgt.id
   where c.household_id = v_h and c.product_id = v_src.id
     and c.from_unit_id <> v_tgt.stock_unit_id
     and not exists (select 1 from public.product_unit_conversion t
                      where t.product_id = v_tgt.id and t.from_unit_id = c.from_unit_id);
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('conversions', v_n);

  -- ── Shopping list: one open item per product per list ──
  delete from public.shopping_list_item i
   where i.household_id = v_h and i.product_id = v_src.id and not i.done and not i.dismissed
     and exists (select 1 from public.shopping_list_item o
                  where o.household_id = v_h and o.list = i.list and o.product_id = v_tgt.id
                    and not o.done and not o.dismissed);
  update public.shopping_list_item i
     set product_id = v_tgt.id,
         unit_id = case when v_mode = 'convert' and i.qty is not null then coalesce(i.unit_id, v_src.stock_unit_id)
                        else i.unit_id end
   where i.household_id = v_h and i.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('list_items', v_n);

  -- ── Jars (after the stock moved; the target must be weighable → GDUNT) ──
  update public.location l set holds_product_id = v_tgt.id
   where l.household_id = v_h and l.holds_product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('containers', v_n);

  -- ── Scale readings, extra QR labels, sub-products ──
  update public.scale_reading r set product_id = v_tgt.id
   where r.household_id = v_h and r.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('readings', v_n);

  update public.label_tag t set product_id = v_tgt.id
   where t.household_id = v_h and t.product_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('labels', v_n);

  update public.product c set parent_id = v_tgt.id
   where c.household_id = v_h and c.parent_id = v_src.id;
  get diagnostics v_n = row_count;
  v_out := v_out || jsonb_build_object('variants', v_n);

  -- ── Fill the target's blanks: usual place, photo ──
  if v_tgt.default_location_id is null and v_src.default_location_id is not null then
    update public.product p set default_location_id = v_src.default_location_id where p.id = v_tgt.id;
  end if;
  if not exists (select 1 from public.attachment a
                  where a.household_id = v_h and a.entity_type = 'product' and a.entity_id = v_tgt.id) then
    update public.attachment a set entity_id = v_tgt.id
     where a.household_id = v_h and a.entity_type = 'product' and a.entity_id = v_src.id;
  end if;

  update public.product p set archived = true, merged_into_id = v_tgt.id where p.id = v_src.id;

  return v_out || jsonb_build_object('mode', v_mode, 'factor', v_factor,
                                     'correlation_id', case when v_mode = 'convert' then v_corr end);
end;
$$;

-- ── rpc_undo: as in migration 26, but a merge's transfers can't be undone ─────
create or replace function public.rpc_undo(p_correlation uuid)
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

revoke execute on function public.rpc_product_merge(uuid, uuid) from public, anon;
grant execute on function public.rpc_product_merge(uuid, uuid) to authenticated;

update public.app_meta set value = '69' where key = 'schema_version';
