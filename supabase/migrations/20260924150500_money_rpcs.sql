-- Phase 2 · 16 — money write RPCs (CLAUDE.md rule 1: balances are only ever changed by writing
-- transactions through these functions; clients have no INSERT/UPDATE/DELETE on the tables).
-- All are SECURITY DEFINER with an explicit private.can_write() check; the composite foreign keys
-- reject any account / category / merchant from another household.
--
-- Error codes the app maps to messages:
--   42501 not allowed · 23514 lines don't add up / bad shape · 23503 unknown account or category
--   GDDUP a transaction with this fingerprint already exists (manual entry: "save another?")

-- ── Line normalisation: unit, base quantity, price per base unit, destiny ────
create function private.transaction_line_normalise()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unit public.unit%rowtype;
  v_key  text;
begin
  new.raw_name := btrim(new.raw_name);
  new.unit_text := nullif(btrim(new.unit_text), '');

  new.unit_id := null;
  new.base_qty := null;
  new.price_per_base := null;
  if new.unit_text is not null then
    v_key := lower(new.unit_text);
    select u.* into v_unit from public.unit u
     where (u.household_id is null or u.household_id = new.household_id)
       and (lower(u.code) = v_key or v_key = any (u.aliases))
     order by (u.household_id is null), (lower(u.code) = v_key) desc
     limit 1;
    if found then
      new.unit_id := v_unit.id;
      if new.qty is not null and new.qty > 0 then
        new.base_qty := round(new.qty * v_unit.to_base, 4);
        if new.amount > 0 then
          new.price_per_base := round(new.amount / new.base_qty, 4);
        end if;
      end if;
    end if;
  end if;

  if new.destiny is null and new.category_id is not null then
    select c.default_destiny into new.destiny from public.category c
     where c.id = new.category_id and c.household_id = new.household_id;
  end if;
  return new;
end;
$$;

create trigger transaction_line_normalise
  before insert or update on public.transaction_line
  for each row execute function private.transaction_line_normalise();

-- ── Helpers (not callable by clients) ────────────────────────────────────────

-- Shop / payee name → merchant (by normalised name or alias); creates it when new.
create function private.resolve_merchant(p_household uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_norm text := private.norm_name(p_name);
  v_id   uuid;
begin
  if v_norm = '' then
    return null;
  end if;
  select m.id into v_id from public.merchant m
   where m.household_id = p_household and (m.name_norm = v_norm or v_norm = any (m.aliases))
   order by (m.name_norm = v_norm) desc
   limit 1;
  if v_id is null then
    insert into public.merchant (household_id, name)
    values (p_household, left(regexp_replace(btrim(p_name), '\s+', ' ', 'g'), 80))
    on conflict (household_id, name_norm) do nothing
    returning id into v_id;
    if v_id is null then
      select m.id into v_id from public.merchant m where m.household_id = p_household and m.name_norm = v_norm;
    end if;
  end if;
  return v_id;
end;
$$;

-- Inserts the lines of one transaction; returns their sum. Line fingerprints must extend the
-- header's (`<tx>-…`), except Sheet imports, which keep the Sheet's own row ids.
create function private.insert_lines(p_household uuid, p_tx uuid, p_tx_fp text, p_source text, p_lines jsonb)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line jsonb;
  v_sum  numeric := 0;
  v_no   integer := 0;
  v_fp   text;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'lines must be an array' using errcode = '23514';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_fp := v_line ->> 'fingerprint';
    if v_fp is null or (p_source <> 'import_sheet' and left(v_fp, length(p_tx_fp) + 1) <> p_tx_fp || '-') then
      raise exception 'line fingerprint % does not belong to %', v_fp, p_tx_fp using errcode = '23514';
    end if;
    insert into public.transaction_line
      (household_id, transaction_id, line_no, raw_name, category_id, qty, unit_text, unit_price, amount, destiny, fingerprint)
    values (
      p_household, p_tx,
      coalesce((v_line ->> 'line_no')::integer, v_no),
      coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), 'item'),
      (v_line ->> 'category_id')::uuid,
      (v_line ->> 'qty')::numeric,
      v_line ->> 'unit_text',
      (v_line ->> 'unit_price')::numeric,
      (v_line ->> 'amount')::numeric,
      v_line ->> 'destiny',
      v_fp);
    v_sum := v_sum + (v_line ->> 'amount')::numeric;
    v_no := v_no + 1;
  end loop;
  return v_sum;
end;
$$;

-- Expense / income / refund must have lines that add up to the total; transfers and adjustments none.
create function private.check_lines(p_type text, p_total numeric, p_count integer, p_sum numeric)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_type in ('expense', 'income', 'refund') then
    if p_count = 0 then
      raise exception 'a % needs at least one line', p_type using errcode = '23514';
    end if;
    if p_sum <> p_total then
      raise exception 'lines add up to % but the total is %', p_sum, p_total using errcode = '23514';
    end if;
  elsif p_count > 0 then
    raise exception 'a % has no lines', p_type using errcode = '23514';
  end if;
end;
$$;

revoke execute on function private.resolve_merchant(uuid, text) from public, anon, authenticated;
revoke execute on function private.insert_lines(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function private.check_lines(text, numeric, integer, numeric) from public, anon, authenticated;

-- ── rpc_save_transaction: create or edit one manual transaction ──────────────
-- p: { id?, household_id, type, account_id, to_account_id?, payee_text?, occurred_on, occurred_at?,
--      invoice_no?, notes?, total, fingerprint (create only), lines: [{raw_name, category_id, qty?,
--      unit_text?, unit_price?, amount, fingerprint}], fee?: {amount, category_id} (transfers) }
-- Editing keeps the fingerprint and source; lines are replaced. Returns { id, fingerprint }.
create function public.rpc_save_transaction(p jsonb)
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
  v_id        uuid := (p ->> 'id')::uuid;
  v_fp        text;
  v_source    text;
  v_merchant  uuid;
  v_sum       numeric;
  v_fee       numeric := coalesce((p #>> '{fee,amount}')::numeric, 0);
  v_fee_id    uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_total is null then
    raise exception 'total is required' using errcode = '23514';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_type <> 'transfer') then
    raise exception 'only transfers can carry a fee' using errcode = '23514';
  end if;

  if v_type in ('expense', 'income', 'refund') then
    v_merchant := private.resolve_merchant(v_household, p ->> 'payee_text');
  end if;

  if v_id is null then
    v_fp := p ->> 'fingerprint';
    v_source := 'manual';
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
    delete from public.transaction_line l where l.transaction_id = v_id;
    delete from public.money_transaction f where f.related_id = v_id and f.household_id = v_household;
  end if;

  v_sum := private.insert_lines(v_household, v_id, v_fp, v_source, v_lines);
  perform private.check_lines(v_type, v_total, jsonb_array_length(v_lines), v_sum);

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

-- ── rpc_import_bills: scanned bills and Sheet history, idempotent ────────────
-- p_bills: [{ type?, account_id, payee_text, occurred_on, occurred_at?, invoice_no?, subtotal?,
--             discount?, total, source ('scan' | 'import_sheet'), fingerprint, notes?,
--             lines: [{line_no, raw_name, category_id, qty?, unit_text?, unit_price?, amount, fingerprint}] }]
-- A bill whose fingerprint (or any line fingerprint) already exists is skipped as 'duplicate'.
-- Returns [{ fingerprint, status: 'imported' | 'duplicate', id }] in input order.
create function public.rpc_import_bills(p_household uuid, p_bills jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill   jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_id     uuid;
  v_fp     text;
  v_type   text;
  v_source text;
  v_total  numeric;
  v_lines  jsonb;
  v_sum    numeric;
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
      insert into public.money_transaction
        (household_id, type, account_id, merchant_id, payee_text, occurred_on, occurred_at, invoice_no,
         subtotal, discount, total, source, fingerprint, notes)
      values
        (p_household, v_type, (v_bill ->> 'account_id')::uuid,
         private.resolve_merchant(p_household, v_bill ->> 'payee_text'),
         nullif(btrim(v_bill ->> 'payee_text'), ''), (v_bill ->> 'occurred_on')::date,
         (v_bill ->> 'occurred_at')::time, nullif(btrim(v_bill ->> 'invoice_no'), ''),
         (v_bill ->> 'subtotal')::numeric, coalesce((v_bill ->> 'discount')::numeric, 0), v_total,
         v_source, v_fp, nullif(btrim(v_bill ->> 'notes'), ''))
      on conflict (household_id, fingerprint) do nothing
      returning id into v_id;
    end if;

    if v_id is null then
      v_out := v_out || jsonb_build_object('fingerprint', v_fp, 'status', 'duplicate',
        'id', (select t.id from public.money_transaction t where t.household_id = p_household and t.fingerprint = v_fp));
      continue;
    end if;

    v_sum := private.insert_lines(p_household, v_id, v_fp, v_source, v_lines);
    perform private.check_lines(v_type, v_total, jsonb_array_length(v_lines), v_sum);
    v_out := v_out || jsonb_build_object('fingerprint', v_fp, 'status', 'imported', 'id', v_id);
  end loop;

  return v_out;
end;
$$;

-- ── rpc_delete_transaction: also removes a transfer's fee ────────────────────
create function public.rpc_delete_transaction(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select t.household_id into v_household from public.money_transaction t where t.id = p_id;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.money_transaction f where f.related_id = p_id and f.household_id = v_household;
  delete from public.money_transaction t where t.id = p_id;
end;
$$;

-- ── rpc_move_transactions: e.g. "Card — to be matched" → Sampath card ────────
-- Only expenses / income / refunds (a transfer's accounts are edited on the transfer itself).
create function public.rpc_move_transactions(p_ids uuid[], p_account uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
begin
  select a.household_id into v_household from public.account a where a.id = p_account;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.money_transaction t
     where t.id = any (p_ids) and (t.household_id <> v_household or t.type not in ('expense', 'income', 'refund'))
  ) then
    raise exception 'only expenses, income and refunds of this household can be moved' using errcode = '42501';
  end if;
  update public.money_transaction t set account_id = p_account
   where t.id = any (p_ids) and t.household_id = v_household;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.rpc_save_transaction(jsonb) from public, anon;
revoke execute on function public.rpc_import_bills(uuid, jsonb) from public, anon;
revoke execute on function public.rpc_delete_transaction(uuid) from public, anon;
revoke execute on function public.rpc_move_transactions(uuid[], uuid) from public, anon;
grant execute on function public.rpc_save_transaction(jsonb) to authenticated;
grant execute on function public.rpc_import_bills(uuid, jsonb) to authenticated;
grant execute on function public.rpc_delete_transaction(uuid) to authenticated;
grant execute on function public.rpc_move_transactions(uuid[], uuid) to authenticated;

update public.app_meta set value = '16' where key = 'schema_version';
