-- Phase 4 · 31 — bill routing: one bill import = expense + stock lots + ticked list (MASTER_PLAN §4 row 1)
-- Each line of a bill decides its destiny: 'stock' (a lot of a product, priced from the line),
-- 'asset' (Things, Phase 5) or 'expense' only. The web app proposes it (category default, learned
-- names, product matching) and sends one `route` per line; these functions apply it atomically.
--
-- Error codes the app maps to messages (as in migrations 16 / 26, plus):
--   GDRTD  this line / bill already feeds the pantry (lines can't be re-routed or rewritten)
--   GDUSE  stock from this bill has been used since, so deleting it can't take the stock back

-- ── private.route_line: apply one line's route ────────────────────────────────
-- p_route: { destiny, product_id? (stock), qty?, unit_id? (default: the line's qty and unit),
--            location_id?, due_date? (explicit null = no date), learn? (default true) }
-- A stock line becomes one lot: quantity converted to the product's stock unit, unit cost = line
-- amount ÷ quantity, bought on the bill's date, due date / place from the product unless given.
-- Open list items for that product are ticked with this line. Returns { lot_id, ticked }.
create function private.route_line(
  p_household uuid, p_line public.transaction_line, p_route jsonb, p_bill_date date, p_merchant uuid,
  p_correlation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destiny  text := p_route ->> 'destiny';
  v_product  public.product%rowtype;
  v_unit     uuid;
  v_qty      numeric;
  v_location uuid;
  v_due      date;
  v_lot      uuid;
  v_ticked   integer := 0;
  v_norm     text;
begin
  if v_destiny is null or v_destiny not in ('stock', 'asset', 'expense') then
    raise exception 'destiny must be stock, asset or expense' using errcode = '23514';
  end if;
  if exists (select 1 from public.stock_lot k where k.household_id = p_household and k.transaction_line_id = p_line.id) then
    raise exception 'line % already feeds the pantry', p_line.line_no using errcode = 'GDRTD';
  end if;

  if v_destiny = 'stock' then
    if p_line.amount < 0 then
      raise exception 'a discount line can''t become stock' using errcode = '23514';
    end if;
    v_product := private.stock_product(p_household, (p_route ->> 'product_id')::uuid);
    if v_product.archived then
      raise exception 'this product is archived' using errcode = '23514';
    end if;
    if p_route ? 'qty' then
      v_unit := (p_route ->> 'unit_id')::uuid;
      v_qty := (p_route ->> 'qty')::numeric;
    else
      v_unit := p_line.unit_id;
      v_qty := coalesce(p_line.qty, 1);
    end if;
    if not private.unit_usable(v_unit, p_household) then
      raise exception 'unknown unit' using errcode = '23503';
    end if;
    v_qty := private.to_stock_qty(v_product.id, v_unit, v_qty);
    if v_qty is null or v_qty <= 0 then
      raise exception 'quantity must be more than 0' using errcode = '23514';
    end if;

    v_location := coalesce((p_route ->> 'location_id')::uuid, v_product.default_location_id);
    v_due := case when p_route ? 'due_date' then (p_route ->> 'due_date')::date
                  else private.default_due(v_product, v_location, p_bill_date) end;
    v_lot := private.stock_new_lot(
      p_household, v_product.id, v_qty, v_location, round(p_line.amount / v_qty, 4), p_bill_date, v_due,
      null, null, p_line.id, 'purchase', p_correlation, null);

    update public.transaction_line l set destiny = 'stock', product_id = v_product.id where l.id = p_line.id;

    with t as (
      update public.shopping_list_item i set done = true, done_by_line = p_line.id
       where i.household_id = p_household and i.product_id = v_product.id and not i.done and not i.dismissed
      returning 1
    )
    select count(*) into v_ticked from t;
  else
    update public.transaction_line l set destiny = v_destiny, product_id = null where l.id = p_line.id;
  end if;

  -- Learn the printed name → where it went (the web app sends learn=false when there's nothing new).
  if coalesce((p_route ->> 'learn')::boolean, true) then
    v_norm := left(private.bill_name_norm(p_line.raw_name), 200);
    if v_norm <> '' then
      insert into public.product_alias (household_id, alias_norm, destiny, product_id, merchant_id)
      values (p_household, v_norm, v_destiny, case when v_destiny = 'stock' then v_product.id end, p_merchant)
      on conflict (household_id, alias_norm) do update set
        destiny = excluded.destiny,
        product_id = excluded.product_id,
        merchant_id = coalesce(excluded.merchant_id, public.product_alias.merchant_id),
        hits = public.product_alias.hits + 1,
        last_used_at = now();
    end if;
  end if;

  return jsonb_build_object('lot_id', v_lot, 'ticked', v_ticked);
end;
$$;

-- Tick free-text (or any open) list items the user marked on the review screen.
create function private.tick_items(p_household uuid, p_ids jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_ids is null or jsonb_typeof(p_ids) = 'null' then
    return 0;
  end if;
  if jsonb_typeof(p_ids) <> 'array' then
    raise exception 'tick_item_ids must be an array' using errcode = '23514';
  end if;
  update public.shopping_list_item i set done = true
   where i.household_id = p_household and not i.done
     and i.id in (select (value #>> '{}')::uuid from jsonb_array_elements(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function private.route_line(uuid, public.transaction_line, jsonb, date, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.tick_items(uuid, jsonb) from public, anon, authenticated;

-- ── rpc_import_bills: now also routes lines (same signature, migration 16's behaviour kept) ──
-- Each line may carry `route` (see private.route_line); a bill may carry `tick_item_ids`.
-- Lines without a route keep their category's default destiny and create nothing. A duplicate bill
-- routes nothing. All lots of one bill share one correlation id.
-- Returns [{ fingerprint, status, id, lots, ticked, correlation_id }] in input order.
create or replace function public.rpc_import_bills(p_household uuid, p_bills jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill     jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_id       uuid;
  v_fp       text;
  v_type     text;
  v_source   text;
  v_total    numeric;
  v_lines    jsonb;
  v_sum      numeric;
  v_merchant uuid;
  v_date     date;
  v_corr     uuid;
  v_line     jsonb;
  v_row      public.transaction_line%rowtype;
  v_res      jsonb;
  v_idx      integer;
  v_lots     integer;
  v_ticked   integer;
begin
  if p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_bills) is distinct from 'array' or jsonb_array_length(p_bills) > 200 then
    raise exception 'bills must be an array of at most 200' using errcode = '23514';
  end if;

  for v_bill in select value from jsonb_array_elements(p_bills) loop
    v_fp := v_bill ->> 'fingerprint';
    v_type := coalesce(v_bill ->> 'type', 'expense');
    v_source := coalesce(v_bill ->> 'source', 'scan');
    v_total := (v_bill ->> 'total')::numeric;
    v_lines := coalesce(v_bill -> 'lines', '[]'::jsonb);
    v_date := (v_bill ->> 'occurred_on')::date;
    if v_source not in ('scan', 'import_sheet') or v_type not in ('expense', 'income', 'refund') then
      raise exception 'bills are scan / import_sheet expenses, income or refunds' using errcode = '23514';
    end if;

    if exists (
      select 1 from public.transaction_line l
       where l.household_id = p_household
         and l.fingerprint in (select value ->> 'fingerprint' from jsonb_array_elements(v_lines))
    ) then
      v_id := null;
    else
      v_merchant := private.resolve_merchant(p_household, v_bill ->> 'payee_text');
      insert into public.money_transaction
        (household_id, type, account_id, merchant_id, payee_text, occurred_on, occurred_at, invoice_no,
         subtotal, discount, total, source, fingerprint, notes)
      values
        (p_household, v_type, (v_bill ->> 'account_id')::uuid, v_merchant,
         nullif(btrim(v_bill ->> 'payee_text'), ''), v_date,
         (v_bill ->> 'occurred_at')::time, nullif(btrim(v_bill ->> 'invoice_no'), ''),
         (v_bill ->> 'subtotal')::numeric, coalesce((v_bill ->> 'discount')::numeric, 0), v_total,
         v_source, v_fp, nullif(btrim(v_bill ->> 'notes'), ''))
      on conflict (household_id, fingerprint) do nothing
      returning id into v_id;
    end if;

    if v_id is null then
      v_out := v_out || jsonb_build_object('fingerprint', v_fp, 'status', 'duplicate',
        'id', (select t.id from public.money_transaction t where t.household_id = p_household and t.fingerprint = v_fp),
        'lots', 0, 'ticked', 0, 'correlation_id', null);
      continue;
    end if;

    v_sum := private.insert_lines(p_household, v_id, v_fp, v_source, v_lines);
    perform private.check_lines(v_type, v_total, jsonb_array_length(v_lines), v_sum);

    -- Routes (same line numbering as private.insert_lines).
    v_corr := gen_random_uuid();
    v_lots := 0;
    v_ticked := 0;
    v_idx := 0;
    for v_line in select value from jsonb_array_elements(v_lines) loop
      if v_line ? 'route' and jsonb_typeof(v_line -> 'route') = 'object' then
        if v_type <> 'expense' then
          raise exception 'only expense lines can be routed' using errcode = '23514';
        end if;
        select * into v_row from public.transaction_line l
         where l.transaction_id = v_id and l.line_no = coalesce((v_line ->> 'line_no')::integer, v_idx);
        v_res := private.route_line(p_household, v_row, v_line -> 'route', v_date, v_merchant, v_corr);
        v_lots := v_lots + case when v_res ->> 'lot_id' is not null then 1 else 0 end;
        v_ticked := v_ticked + (v_res ->> 'ticked')::integer;
      end if;
      v_idx := v_idx + 1;
    end loop;
    v_ticked := v_ticked + private.tick_items(p_household, v_bill -> 'tick_item_ids');

    v_out := v_out || jsonb_build_object('fingerprint', v_fp, 'status', 'imported', 'id', v_id,
      'lots', v_lots, 'ticked', v_ticked, 'correlation_id', case when v_lots > 0 then v_corr end);
  end loop;

  return v_out;
end;
$$;

-- ── rpc_route_lines: route lines of a bill that is already in Gedara ──────────
-- ("Send to pantry" on an SMS / manual / older bill.) p_routes: [{ line_id, …route }].
-- Returns { lots, ticked, correlation_id }.
create function public.rpc_route_lines(p_transaction uuid, p_routes jsonb, p_tick jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx     public.money_transaction%rowtype;
  v_corr   uuid := gen_random_uuid();
  v_route  jsonb;
  v_row    public.transaction_line%rowtype;
  v_res    jsonb;
  v_lots   integer := 0;
  v_ticked integer := 0;
begin
  select * into v_tx from public.money_transaction t where t.id = p_transaction;
  if not found or not private.can_write(v_tx.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.money_transaction t where t.id = p_transaction for update;
  if v_tx.type <> 'expense' then
    raise exception 'only expense lines can be routed' using errcode = '23514';
  end if;
  if jsonb_typeof(p_routes) is distinct from 'array' or jsonb_array_length(p_routes) > 300 then
    raise exception 'routes must be an array' using errcode = '23514';
  end if;

  for v_route in select value from jsonb_array_elements(p_routes) loop
    select * into v_row from public.transaction_line l
     where l.id = (v_route ->> 'line_id')::uuid and l.transaction_id = p_transaction;
    if not found then
      raise exception 'unknown line' using errcode = '23503';
    end if;
    v_res := private.route_line(v_tx.household_id, v_row, v_route - 'line_id', v_tx.occurred_on, v_tx.merchant_id, v_corr);
    v_lots := v_lots + case when v_res ->> 'lot_id' is not null then 1 else 0 end;
    v_ticked := v_ticked + (v_res ->> 'ticked')::integer;
  end loop;
  v_ticked := v_ticked + private.tick_items(v_tx.household_id, p_tick);

  return jsonb_build_object('lots', v_lots, 'ticked', v_ticked,
                            'correlation_id', case when v_lots > 0 then v_corr end);
end;
$$;

-- ── private.save_transaction: keep routed lines ───────────────────────────────
-- Same as migration 20, plus: a bill whose lines feed the pantry keeps its lines. Editing it sends
-- `keep_lines: true` (header only — date, account, payee, notes; the total must still match the
-- lines); anything else is refused with GDRTD instead of silently cutting the lots' link.
create or replace function private.save_transaction(p jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_type      text := p ->> 'type';
  v_total     numeric := (p ->> 'total')::numeric;
  v_lines     jsonb := coalesce(p -> 'lines', '[]'::jsonb);
  v_keep      boolean := coalesce((p ->> 'keep_lines')::boolean, false);
  v_id        uuid := (p ->> 'id')::uuid;
  v_fp        text;
  v_source    text;
  v_merchant  uuid;
  v_sum       numeric;
  v_count     integer;
  v_fee       numeric := coalesce((p #>> '{fee,amount}')::numeric, 0);
  v_fee_id    uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_source not in ('manual', 'sms') then
    raise exception 'unsupported source %', p_source using errcode = '23514';
  end if;
  if v_total is null then
    raise exception 'total is required' using errcode = '23514';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_type <> 'transfer') then
    raise exception 'only transfers can carry a fee' using errcode = '23514';
  end if;
  if v_keep and v_id is null then
    raise exception 'keep_lines is for edits' using errcode = '23514';
  end if;

  if v_type in ('expense', 'income', 'refund') then
    v_merchant := private.resolve_merchant(v_household, p ->> 'payee_text');
  end if;

  if v_id is null then
    v_fp := p ->> 'fingerprint';
    v_source := p_source;
    insert into public.money_transaction
      (household_id, type, account_id, to_account_id, merchant_id, payee_text, occurred_on, occurred_at,
       invoice_no, total, source, fingerprint, notes)
    values
      (v_household, v_type, (p ->> 'account_id')::uuid, (p ->> 'to_account_id')::uuid, v_merchant,
       nullif(btrim(p ->> 'payee_text'), ''), (p ->> 'occurred_on')::date, (p ->> 'occurred_at')::time,
       nullif(btrim(p ->> 'invoice_no'), ''), v_total, v_source, v_fp, nullif(btrim(p ->> 'notes'), ''))
    on conflict (household_id, fingerprint) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception 'already saved: %', v_fp using errcode = 'GDDUP';
    end if;
  else
    select t.fingerprint, t.source into v_fp, v_source from public.money_transaction t
     where t.id = v_id and t.household_id = v_household
     for update;
    if not found then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if not v_keep and exists (
      select 1 from public.transaction_line l
       where l.transaction_id = v_id
         and (l.product_id is not null
              or exists (select 1 from public.stock_lot k
                          where k.household_id = v_household and k.transaction_line_id = l.id))
    ) then
      raise exception 'this bill''s lines feed the pantry' using errcode = 'GDRTD';
    end if;
    update public.money_transaction t set
      type = v_type,
      account_id = (p ->> 'account_id')::uuid,
      to_account_id = (p ->> 'to_account_id')::uuid,
      merchant_id = v_merchant,
      payee_text = nullif(btrim(p ->> 'payee_text'), ''),
      occurred_on = (p ->> 'occurred_on')::date,
      occurred_at = (p ->> 'occurred_at')::time,
      invoice_no = nullif(btrim(p ->> 'invoice_no'), ''),
      total = v_total,
      notes = nullif(btrim(p ->> 'notes'), '')
     where t.id = v_id;
    if not v_keep then
      delete from public.transaction_line l where l.transaction_id = v_id;
    end if;
    delete from public.money_transaction f where f.related_id = v_id and f.household_id = v_household;
  end if;

  if v_keep then
    select coalesce(sum(l.amount), 0), count(*)::integer into v_sum, v_count
      from public.transaction_line l where l.transaction_id = v_id;
  else
    v_sum := private.insert_lines(v_household, v_id, v_fp, v_source, v_lines);
    v_count := jsonb_array_length(v_lines);
  end if;
  perform private.check_lines(v_type, v_total, v_count, v_sum);

  -- A transfer's fee (e.g. the Rs 25 CEFT charge) is its own expense from the same account.
  if v_fee > 0 then
    insert into public.money_transaction
      (household_id, type, account_id, payee_text, occurred_on, occurred_at, total, source, fingerprint, related_id)
    values
      (v_household, 'expense', (p ->> 'account_id')::uuid, 'Transfer fee', (p ->> 'occurred_on')::date,
       (p ->> 'occurred_at')::time, v_fee, v_source, v_fp || '~fee', v_id)
    returning id into v_fee_id;
    insert into public.transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint)
    values (v_household, v_fee_id, 0, 'Transfer fee', (p #>> '{fee,category_id}')::uuid, v_fee, v_fp || '~fee-0-fee');
  end if;

  return jsonb_build_object('id', v_id, 'fingerprint', v_fp);
end;
$$;

-- ── rpc_delete_transaction: also takes back the stock the bill added ──────────
-- Each purchase the bill made (its correlation) is undone with rpc_undo, which refuses when that
-- stock was used, opened or moved since → GDUSE. With p_keep_stock the lots stay (they just lose
-- their link to the bill). List items the bill ticked are opened again, unless the product is
-- already back on the list.
drop function public.rpc_delete_transaction(uuid);

create function public.rpc_delete_transaction(p_id uuid, p_keep_stock boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_corr      uuid;
begin
  select t.household_id into v_household from public.money_transaction t where t.id = p_id;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.money_transaction t where t.id = p_id for update;

  if not coalesce(p_keep_stock, false) then
    for v_corr in
      select distinct m.correlation_id
        from public.stock_movement m
        join public.stock_lot k on k.id = m.lot_id and k.household_id = m.household_id
        join public.transaction_line l on l.id = k.transaction_line_id and l.household_id = k.household_id
       where l.transaction_id = p_id and m.reason = 'purchase'
         and not exists (select 1 from public.stock_movement u where u.reverses_id = m.id)
    loop
      begin
        perform public.rpc_undo(v_corr);
      exception when sqlstate 'GDUND' then
        raise exception 'stock from this bill has been used since' using errcode = 'GDUSE';
      end;
    end loop;
  end if;

  update public.shopping_list_item i set done = false
   where i.household_id = v_household
     and i.done_by_line in (select l.id from public.transaction_line l where l.transaction_id = p_id)
     and not exists (
       select 1 from public.shopping_list_item o
        where o.household_id = i.household_id and o.list = i.list and o.product_id = i.product_id
          and not o.done and not o.dismissed);

  delete from public.money_transaction f where f.related_id = p_id and f.household_id = v_household;
  delete from public.money_transaction t where t.id = p_id;
end;
$$;

revoke execute on function public.rpc_route_lines(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.rpc_delete_transaction(uuid, boolean) from public, anon;
grant execute on function public.rpc_route_lines(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.rpc_delete_transaction(uuid, boolean) to authenticated;

update public.app_meta set value = '31' where key = 'schema_version';
