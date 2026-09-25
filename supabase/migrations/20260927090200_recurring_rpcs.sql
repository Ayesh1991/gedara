-- Phase 6 · 42 — paying recurring bills + when they are due
--   rpc_recurring_pay(p)       save the expense/income (same checks as rpc_save_transaction) and link it,
--                              with optional units (kWh / m³) — one step, one Undo (delete the payment)
--   rpc_recurring_link(...)    a bill already in Money (SMS, scanned) pays a period
--   rpc_recurring_unlink(tx)   the transaction stays, the bill is due again
-- Skipping a period is a plain insert into recurring_skip (RLS).

-- ── v_recurring_due ───────────────────────────────────────────────────────────
create view public.v_recurring_due
with (security_invoker = true) as
  select r.id, r.household_id, r.name, r.type, r.account_id, r.category_id, r.payee_text, r.expected_amount,
         r.every_n, r.every_unit, r.first_due, r.notify_days_before, r.usage_unit, r.asset_id, r.active, r.notes,
         r.created_at,
         c.name as category_name,
         coalesce(c.parent_id, c.id) as top_category_id,
         a.name as account_name,
         x.name as asset_name,
         pay.last_period,
         pay.last_paid_on,
         pay.last_amount,
         pay.last_transaction_id,
         coalesce(pay.payments, 0) as payments,
         sk.last_skipped,
         nd.next_due,
         nd.next_due - z.today as days_left,
         z.today
    from public.recurring_rule r
    join public.household h on h.id = r.household_id
    cross join lateral (select (now() at time zone h.timezone)::date as today) z
    left join public.category c on c.id = r.category_id and c.household_id = r.household_id
    left join public.account a on a.id = r.account_id and a.household_id = r.household_id
    left join public.asset x on x.id = r.asset_id and x.household_id = r.household_id
    left join lateral (
      select max(t.recurring_period) as last_period,
             (array_agg(t.occurred_on order by t.recurring_period desc))[1] as last_paid_on,
             (array_agg(t.total order by t.recurring_period desc))[1] as last_amount,
             (array_agg(t.id order by t.recurring_period desc))[1] as last_transaction_id,
             count(*)::integer as payments
        from public.money_transaction t
       where t.household_id = r.household_id and t.recurring_id = r.id
    ) pay on true
    left join lateral (
      select max(s.period) as last_skipped from public.recurring_skip s
       where s.household_id = r.household_id and s.rule_id = r.id
    ) sk on true
    cross join lateral (
      select private.recurring_next(r.first_due, r.every_n, r.every_unit,
                                    nullif(greatest(coalesce(pay.last_period, '-infinity'::date),
                                                    coalesce(sk.last_skipped, '-infinity'::date)),
                                           '-infinity'::date)) as next_due
    ) nd;

revoke all on public.v_recurring_due from anon, authenticated;
grant select on public.v_recurring_due to authenticated;

-- ── helpers ───────────────────────────────────────────────────────────────────
create function private.recurring_next_due(p_rule uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.recurring_next(r.first_due, r.every_n, r.every_unit,
           nullif(greatest(
             coalesce((select max(t.recurring_period) from public.money_transaction t
                        where t.household_id = r.household_id and t.recurring_id = r.id), '-infinity'::date),
             coalesce((select max(s.period) from public.recurring_skip s
                        where s.household_id = r.household_id and s.rule_id = r.id), '-infinity'::date)),
           '-infinity'::date))
    from public.recurring_rule r where r.id = p_rule
$$;

-- Link tx → rule/period (+ units). Caller has checked rights. GDRPP = that period is already paid.
create function private.recurring_attach(p_rule public.recurring_rule, p_tx uuid, p_period date, p_units numeric)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period date := coalesce(p_period, private.recurring_next_due(p_rule.id));
  v_on     date;
begin
  if exists (select 1 from public.money_transaction t
              where t.household_id = p_rule.household_id and t.recurring_id = p_rule.id
                and t.recurring_period = v_period and t.id <> p_tx) then
    raise exception 'this bill is already paid for %', v_period using errcode = 'GDRPP';
  end if;
  update public.money_transaction t
     set recurring_id = p_rule.id, recurring_period = v_period
   where t.id = p_tx
  returning t.occurred_on into v_on;
  delete from public.meter_reading m where m.transaction_id = p_tx;
  if p_units is not null then
    if p_units <= 0 then
      raise exception 'units must be more than 0' using errcode = '23514';
    end if;
    insert into public.meter_reading (household_id, recurring_id, transaction_id, read_on, units)
    values (p_rule.household_id, p_rule.id, p_tx, v_on, p_units);
  end if;
  return v_period;
end;
$$;

revoke execute on function private.recurring_next_due(uuid) from public, anon, authenticated;
revoke execute on function private.recurring_attach(public.recurring_rule, uuid, date, numeric) from public, anon, authenticated;

-- ── rpc_recurring_pay ─────────────────────────────────────────────────────────
-- p: { rule_id, period?, units?, transaction: <rpc_save_transaction payload without household_id> }
-- The transaction's type must be the rule's. Returns { id, fingerprint, period }.
create function public.rpc_recurring_pay(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule   public.recurring_rule%rowtype;
  v_tx     jsonb := p -> 'transaction';
  v_res    jsonb;
  v_period date;
begin
  select r.* into v_rule from public.recurring_rule r where r.id = (p ->> 'rule_id')::uuid;
  if not found or not private.can_write(v_rule.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_tx is null or jsonb_typeof(v_tx) <> 'object' or v_tx ? 'id' then
    raise exception 'a new transaction is required' using errcode = '23514';
  end if;
  if coalesce(v_tx ->> 'type', '') <> v_rule.type then
    raise exception 'this bill is a %', v_rule.type using errcode = '23514';
  end if;

  v_res := private.save_transaction(v_tx || jsonb_build_object('household_id', v_rule.household_id), 'manual');
  update public.money_transaction t set source = 'recurring' where t.id = (v_res ->> 'id')::uuid;
  v_period := private.recurring_attach(v_rule, (v_res ->> 'id')::uuid, (p ->> 'period')::date, (p ->> 'units')::numeric);
  return v_res || jsonb_build_object('period', v_period);
end;
$$;

-- ── rpc_recurring_link / unlink ───────────────────────────────────────────────
create function public.rpc_recurring_link(p_rule uuid, p_transaction uuid, p_period date default null,
                                          p_units numeric default null)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.recurring_rule%rowtype;
begin
  select r.* into v_rule from public.recurring_rule r where r.id = p_rule;
  if not found or not private.can_write(v_rule.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.money_transaction t
   where t.id = p_transaction and t.household_id = v_rule.household_id and t.type = v_rule.type
   for update;
  if not found then
    raise exception 'unknown %', v_rule.type using errcode = '23503';
  end if;
  return private.recurring_attach(v_rule, p_transaction, p_period, p_units);
end;
$$;

create function public.rpc_recurring_unlink(p_transaction uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select t.household_id into v_household from public.money_transaction t where t.id = p_transaction;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.meter_reading m where m.transaction_id = p_transaction;
  update public.money_transaction t set recurring_id = null, recurring_period = null where t.id = p_transaction;
end;
$$;

revoke execute on function public.rpc_recurring_pay(jsonb) from public, anon;
revoke execute on function public.rpc_recurring_link(uuid, uuid, date, numeric) from public, anon;
revoke execute on function public.rpc_recurring_unlink(uuid) from public, anon;
grant execute on function public.rpc_recurring_pay(jsonb) to authenticated;
grant execute on function public.rpc_recurring_link(uuid, uuid, date, numeric) to authenticated;
grant execute on function public.rpc_recurring_unlink(uuid) to authenticated;

update public.app_meta set value = '42' where key = 'schema_version';
