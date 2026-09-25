-- Phase 5 · 37 — Things ↔ Money (MASTER_PLAN §4 rows 5 and 6)
-- A maintenance log with a cost creates (or links) the ledger expense; selling an asset creates the
-- income. Both use private.save_transaction with source 'manual' (fingerprints from the web app,
-- rule 5), so every rupee is still a transaction_line. The links are protected from the Money side:
-- a bill line that bought an asset can't be rewritten or re-routed (GDRTD), and deleting a sale's
-- income brings the asset back.
--
-- Error codes (see migrations 16 / 31 / 33): GDRTD, GDSLD, GDDUP (from save_transaction).

-- ── Guards on bill lines that bought things ──────────────────────────────────
-- Editing a bill replaces its lines unless `keep_lines`; a line an asset points at must survive, or
-- the asset silently loses its receipt. Deleting the whole bill is fine (the asset keeps its price,
-- date and shop; the FK just unlinks it): then the bill row is already gone when its lines cascade.
create function private.transaction_line_keep_assets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.asset a where a.household_id = old.household_id and a.transaction_line_id = old.id)
       and exists (select 1 from public.money_transaction t where t.id = old.transaction_id) then
      raise exception 'line % of this bill is a thing in Things', old.line_no using errcode = 'GDRTD';
    end if;
    return old;
  end if;
  -- UPDATE of destiny: a Things line with assets stays a Things line.
  if old.destiny = 'asset' and new.destiny is distinct from 'asset'
     and exists (select 1 from public.asset a where a.household_id = old.household_id and a.transaction_line_id = old.id) then
    raise exception 'line % is already a thing in Things', old.line_no using errcode = 'GDRTD';
  end if;
  return new;
end;
$$;

create trigger transaction_line_keep_assets
  before delete or update of destiny on public.transaction_line
  for each row execute function private.transaction_line_keep_assets();

-- Deleting a sale's income (from Money, or by undoing the sale) returns the thing(s) to "in use".
create function private.money_transaction_unsell()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.asset a
     set status = 'in_use', sale_transaction_id = null
   where a.household_id = old.household_id and a.sale_transaction_id = old.id;
  return old;
end;
$$;

create trigger money_transaction_unsell
  before delete on public.money_transaction
  for each row execute function private.money_transaction_unsell();

-- ── rpc_log_maintenance ───────────────────────────────────────────────────────
-- p: { asset_id, plan_id?, done_on, title, notes?, vendor?, usage_reading?, cost?,
--      expense?: { account_id, category_id, fingerprint, line_fingerprint }   -- create the expense
--      link_transaction_id? }                                                  -- or use an existing one
-- The created expense is dated done_on, paid to the vendor, one line "<thing> — <title>" in the given
-- category. A linked expense must be an expense of this household; the cost defaults to its total.
-- Returns { id, transaction_id }.
create function public.rpc_log_maintenance(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset   public.asset%rowtype;
  v_cost    numeric := (p ->> 'cost')::numeric;
  v_done    date := (p ->> 'done_on')::date;
  v_title   text := btrim(p ->> 'title');
  v_vendor  text := nullif(btrim(p ->> 'vendor'), '');
  v_link    uuid := (p ->> 'link_transaction_id')::uuid;
  v_tx      uuid;
  v_total   numeric;
  v_created boolean := false;
  v_name    text;
  v_id      uuid;
begin
  select a.* into v_asset from public.asset a where a.id = (p ->> 'asset_id')::uuid;
  if not found or not private.can_write(v_asset.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_done := coalesce(v_done, private.household_today(v_asset.household_id));
  if v_title is null or v_title = '' then
    raise exception 'say what was done' using errcode = '23514';
  end if;
  if p ? 'expense' and v_link is not null then
    raise exception 'create an expense or link one, not both' using errcode = '23514';
  end if;

  if p ? 'expense' then
    if v_cost is null or v_cost <= 0 then
      raise exception 'an expense needs a cost' using errcode = '23514';
    end if;
    v_name := left(v_asset.name || ' — ' || v_title, 200);
    v_tx := (private.save_transaction(jsonb_build_object(
      'household_id', v_asset.household_id,
      'type', 'expense',
      'account_id', p #>> '{expense,account_id}',
      'payee_text', coalesce(v_vendor, v_title),
      'occurred_on', v_done,
      'total', v_cost,
      'fingerprint', p #>> '{expense,fingerprint}',
      'notes', 'A-' || lpad(v_asset.asset_no::text, 4, '0') || ' · ' || v_title,
      'lines', jsonb_build_array(jsonb_build_object(
        'line_no', 0, 'raw_name', v_name, 'category_id', p #>> '{expense,category_id}', 'amount', v_cost,
        'destiny', 'expense', 'fingerprint', p #>> '{expense,line_fingerprint}'))
    ), 'manual') ->> 'id')::uuid;
    v_created := true;
  elsif v_link is not null then
    select t.id, t.total into v_tx, v_total from public.money_transaction t
     where t.id = v_link and t.household_id = v_asset.household_id and t.type = 'expense';
    if not found then
      raise exception 'unknown expense' using errcode = '23503';
    end if;
    v_cost := coalesce(v_cost, v_total);
  end if;

  insert into public.maintenance_log
    (household_id, asset_id, plan_id, done_on, title, notes, cost, vendor, transaction_id, created_expense, usage_reading)
  values
    (v_asset.household_id, v_asset.id, (p ->> 'plan_id')::uuid, v_done, v_title, p ->> 'notes', v_cost, v_vendor,
     v_tx, v_created, (p ->> 'usage_reading')::numeric)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'transaction_id', v_tx);
end;
$$;

-- ── rpc_delete_maintenance_log ────────────────────────────────────────────────
-- Removes a log; with p_delete_expense also the expense it created (never a linked one).
create function public.rpc_delete_maintenance_log(p_id uuid, p_delete_expense boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log public.maintenance_log%rowtype;
begin
  select g.* into v_log from public.maintenance_log g where g.id = p_id for update;
  if not found or not private.can_write(v_log.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.maintenance_log g where g.id = p_id;
  if coalesce(p_delete_expense, false) and v_log.created_expense and v_log.transaction_id is not null then
    perform public.rpc_delete_transaction(v_log.transaction_id, false);
  end if;
end;
$$;

-- ── rpc_asset_sell ────────────────────────────────────────────────────────────
-- p: { asset_id, sold_on, sold_to?, price, account_id, category_id, fingerprint, line_fingerprint,
--      include_parts? }
-- Creates the income (one line "Sold: <thing>") and marks the thing — and, with include_parts, all
-- its parts — sold, linked to that income. Giving away (no money) is status 'disposed' instead.
-- Returns { transaction_id }.
create function public.rpc_asset_sell(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.asset%rowtype;
  v_price numeric := (p ->> 'price')::numeric;
  v_on    date := (p ->> 'sold_on')::date;
  v_to    text := nullif(btrim(p ->> 'sold_to'), '');
  v_tx    uuid;
begin
  select a.* into v_asset from public.asset a where a.id = (p ->> 'asset_id')::uuid;
  if not found or not private.can_write(v_asset.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.asset a where a.id = v_asset.id for update;
  v_on := coalesce(v_on, private.household_today(v_asset.household_id));
  if v_asset.status = 'sold' then
    raise exception 'already sold' using errcode = 'GDSLD';
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'a sale needs a price' using errcode = '23514';
  end if;

  v_tx := (private.save_transaction(jsonb_build_object(
    'household_id', v_asset.household_id,
    'type', 'income',
    'account_id', p ->> 'account_id',
    'payee_text', v_to,
    'occurred_on', v_on,
    'total', v_price,
    'fingerprint', p ->> 'fingerprint',
    'notes', 'A-' || lpad(v_asset.asset_no::text, 4, '0') || ' sold',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_no', 0, 'raw_name', left('Sold: ' || v_asset.name, 200), 'category_id', p ->> 'category_id',
      'amount', v_price, 'destiny', 'expense', 'fingerprint', p ->> 'line_fingerprint'))
  ), 'manual') ->> 'id')::uuid;

  update public.asset a
     set status = 'sold', sold_on = v_on, sold_to = v_to, sold_price = v_price, sale_transaction_id = v_tx
   where a.id = v_asset.id;

  if coalesce((p ->> 'include_parts')::boolean, false) then
    with recursive parts (id, depth) as (
      select a.id, 1 from public.asset a where a.household_id = v_asset.household_id and a.parent_id = v_asset.id
      union all
      select a.id, s.depth + 1 from public.asset a join parts s on a.parent_id = s.id where s.depth < 64
    )
    update public.asset a
       set status = 'sold', sold_on = v_on, sold_to = v_to, sold_price = null, sale_transaction_id = v_tx
     where a.id in (select id from parts) and a.status <> 'sold';
  end if;

  return jsonb_build_object('transaction_id', v_tx);
end;
$$;

-- ── rpc_asset_unsell ──────────────────────────────────────────────────────────
-- Undo a sale: the thing that carried the price deletes the income (which brings back every thing
-- sold with it); a part sold along with its parent just comes back on its own.
create function public.rpc_asset_unsell(p_asset uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.asset%rowtype;
begin
  select a.* into v_asset from public.asset a where a.id = p_asset for update;
  if not found or not private.can_write(v_asset.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_asset.status <> 'sold' then
    raise exception 'not sold' using errcode = 'GDSLD';
  end if;
  if v_asset.sale_transaction_id is not null and v_asset.sold_price is not null then
    perform public.rpc_delete_transaction(v_asset.sale_transaction_id, false);
  else
    update public.asset a set status = 'in_use', sale_transaction_id = null where a.id = p_asset;
  end if;
end;
$$;

-- ── rpc_asset_split ───────────────────────────────────────────────────────────
-- "6 chairs" as one row → 6 rows of 1 (each can then get its own place, serial, label). Price and
-- salvage are divided (the first row takes the rounding cents); tags, bill link, warranty and the
-- rest are copied; photos and documents stay on the first row. Returns the new ids.
create function public.rpc_asset_split(p_asset uuid)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a      public.asset%rowtype;
  v_n      integer;
  v_price  numeric;
  v_salv   numeric;
  v_new    uuid;
  v_ids    uuid[] := '{}';
  i        integer;
begin
  select a.* into v_a from public.asset a where a.id = p_asset for update;
  if not found or not private.can_write(v_a.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_n := v_a.quantity;
  if v_n < 2 or v_n > 100 then
    raise exception 'split needs a quantity of 2 to 100' using errcode = '23514';
  end if;
  if v_a.status = 'sold' then
    raise exception 'a sold thing can''t be split' using errcode = 'GDSLD';
  end if;
  v_price := round(v_a.purchase_price / v_n, 2);
  v_salv := round(v_a.salvage_value / v_n, 2);

  update public.asset a
     set quantity = 1,
         purchase_price = v_a.purchase_price - v_price * (v_n - 1),
         salvage_value = v_a.salvage_value - v_salv * (v_n - 1)
   where a.id = v_a.id;

  for i in 2 .. v_n loop
    insert into public.asset
      (household_id, name, description, category_id, location_id, parent_id, quantity, manufacturer, model_no,
       condition, status, lent_to, lent_on, transaction_line_id, purchase_price, purchased_on, vendor,
       useful_life_months, salvage_value, warranty_until, lifetime_warranty, warranty_notes, insured,
       insurance_notes, custom)
    values
      (v_a.household_id, v_a.name, v_a.description, v_a.category_id, v_a.location_id, v_a.parent_id, 1,
       v_a.manufacturer, v_a.model_no, v_a.condition, v_a.status, v_a.lent_to, v_a.lent_on, v_a.transaction_line_id,
       v_price, v_a.purchased_on, v_a.vendor, v_a.useful_life_months, v_salv, v_a.warranty_until,
       v_a.lifetime_warranty, v_a.warranty_notes, v_a.insured, v_a.insurance_notes, v_a.custom)
    returning id into v_new;
    insert into public.asset_tag (household_id, asset_id, tag_id)
    select v_a.household_id, v_new, t.tag_id from public.asset_tag t where t.asset_id = v_a.id;
    v_ids := v_ids || v_new;
  end loop;
  return v_ids;
end;
$$;

revoke execute on function public.rpc_log_maintenance(jsonb) from public, anon;
revoke execute on function public.rpc_delete_maintenance_log(uuid, boolean) from public, anon;
revoke execute on function public.rpc_asset_sell(jsonb) from public, anon;
revoke execute on function public.rpc_asset_unsell(uuid) from public, anon;
revoke execute on function public.rpc_asset_split(uuid) from public, anon;
grant execute on function public.rpc_log_maintenance(jsonb) to authenticated;
grant execute on function public.rpc_delete_maintenance_log(uuid, boolean) to authenticated;
grant execute on function public.rpc_asset_sell(jsonb) to authenticated;
grant execute on function public.rpc_asset_unsell(uuid) to authenticated;
grant execute on function public.rpc_asset_split(uuid) to authenticated;

update public.app_meta set value = '37' where key = 'schema_version';
