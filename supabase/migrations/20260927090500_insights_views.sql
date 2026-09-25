-- Phase 6 · 45 — Insights (MASTER_PLAN §6): the facts every drill-down is built from
-- All views are security_invoker (the caller's RLS) and computed live — no materialized views: one
-- household's data is small, and live views can't go stale or leak across households.
-- Drill contract: Domain → Category → Sub-category / Product → the record (a bill line or a stock
-- movement). Grouped totals come from insights_spend() because PostgREST returns ≤ 1000 rows.

-- ── Spend: one row per expense / refund line ──────────────────────────────────
create view public.v_spend_line
with (security_invoker = true) as
  select l.household_id,
         l.id as line_id,
         l.transaction_id,
         l.line_no,
         l.raw_name,
         t.type,
         t.occurred_on,
         date_trunc('month', t.occurred_on)::date as month,
         extract(isodow from t.occurred_on)::integer as weekday,       -- 1 = Monday
         extract(hour from t.occurred_at)::integer as hour,            -- null when the bill has no time
         l.category_id,
         c.name as category_name,
         coalesce(c.parent_id, c.id) as top_category_id,
         coalesce(pc.name, c.name) as top_category_name,
         t.merchant_id,
         coalesce(m.name, t.payee_text) as merchant_name,
         t.payee_text,
         t.account_id,
         a.name as account_name,
         a.kind as account_kind,
         l.product_id,
         p.name as product_name,
         l.destiny,
         t.recurring_id,
         l.qty,
         l.unit_text,
         l.price_per_base,
         case when t.type = 'refund' then -l.amount else l.amount end as amount
    from public.transaction_line l
    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
    join public.account a on a.id = t.account_id and a.household_id = t.household_id
    left join public.category c on c.id = l.category_id and c.household_id = l.household_id
    left join public.category pc on pc.id = c.parent_id and pc.household_id = c.household_id
    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
    left join public.product p on p.id = l.product_id and p.household_id = l.household_id
   where t.type in ('expense', 'refund');

-- Grouped spend. p: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (inclusive), by: see below,
--   cat?, sub?, product?, name?, merchant?, account?, kind?, recurring?: bool }
-- by: top | category | item | merchant | account | kind | month | weekday_hour | recurring
-- `key` is what the next level filters on ('none' = no category / shop / product).
create function public.insights_spend(p_household uuid, p jsonb)
returns table (key text, label text, amount numeric, lines integer, bills integer, first_on date, last_on date)
language sql
stable
set search_path = ''
as $$
  with f as (
    select v.*,
           case p ->> 'by'
             when 'top' then coalesce(v.top_category_id::text, 'none')
             when 'category' then coalesce(v.category_id::text, 'none')
             when 'item' then coalesce(v.product_id::text, 'n:' || lower(btrim(v.raw_name)))
             when 'merchant' then coalesce(v.merchant_id::text, 'none')
             when 'account' then v.account_id::text
             when 'kind' then v.account_kind
             when 'month' then to_char(v.month, 'YYYY-MM')
             when 'weekday_hour' then v.weekday || ':' || coalesce(v.hour::text, 'none')
             when 'recurring' then (v.recurring_id is not null)::text
           end as k,
           case p ->> 'by'
             when 'top' then v.top_category_name
             when 'category' then v.category_name
             when 'item' then coalesce(v.product_name, v.raw_name)
             when 'merchant' then v.merchant_name
             when 'account' then v.account_name
             when 'kind' then v.account_kind
             when 'month' then to_char(v.month, 'YYYY-MM')
             when 'weekday_hour' then v.weekday || ':' || coalesce(v.hour::text, 'none')
             when 'recurring' then (v.recurring_id is not null)::text
           end as l
      from public.v_spend_line v
     where v.household_id = p_household
       and (p ->> 'from' is null or v.occurred_on >= (p ->> 'from')::date)
       and (p ->> 'to' is null or v.occurred_on <= (p ->> 'to')::date)
       and (p ->> 'cat' is null or coalesce(v.top_category_id::text, 'none') = p ->> 'cat')
       and (p ->> 'sub' is null or coalesce(v.category_id::text, 'none') = p ->> 'sub')
       and (p ->> 'product' is null or v.product_id::text = p ->> 'product')
       and (p ->> 'name' is null or (v.product_id is null and lower(btrim(v.raw_name)) = lower(btrim(p ->> 'name'))))
       and (p ->> 'merchant' is null or coalesce(v.merchant_id::text, 'none') = p ->> 'merchant')
       and (p ->> 'account' is null or v.account_id::text = p ->> 'account')
       and (p ->> 'kind' is null or v.account_kind = p ->> 'kind')
       and (p ->> 'recurring' is null or (v.recurring_id is not null) = (p ->> 'recurring')::boolean)
  )
  select f.k, min(f.l), sum(f.amount), count(*)::integer, count(distinct f.transaction_id)::integer,
         min(f.occurred_on), max(f.occurred_on)
    from f
   where f.k is not null
   group by f.k
   order by sum(f.amount) desc
$$;

-- ── Cash flow: every account's balance at the end of each month ───────────────
-- balance(d) = opening_balance + Σ effects in (opening_on, d]   when d ≥ opening_on
--            = opening_balance − Σ effects in (d, opening_on]   when d < opening_on
-- From the month of the first transaction (or the opening) to this month; set-up accounts only.
create view public.v_account_month_end
with (security_invoker = true) as
  select a.household_id, a.id as account_id, a.name as account_name, a.kind, mo.month,
         a.opening_balance
           + coalesce((select sum(e.effect) from public.v_account_effect e
                        where e.account_id = a.id and e.household_id = a.household_id
                          and e.occurred_on > a.opening_on
                          and e.occurred_on <= (mo.month + interval '1 month' - interval '1 day')::date), 0)
           - coalesce((select sum(e.effect) from public.v_account_effect e
                        where e.account_id = a.id and e.household_id = a.household_id
                          and e.occurred_on > (mo.month + interval '1 month' - interval '1 day')::date
                          and e.occurred_on <= a.opening_on), 0)
           as balance
    from public.account a
    join public.household h on h.id = a.household_id
    cross join lateral generate_series(
      date_trunc('month', least(a.opening_on,
                                coalesce((select min(e.occurred_on) from public.v_account_effect e
                                           where e.account_id = a.id and e.household_id = a.household_id),
                                         a.opening_on))::timestamp),
      date_trunc('month', (now() at time zone h.timezone)),
      interval '1 month') as g(m)
    cross join lateral (select g.m::date as month) mo
   where a.opening_on is not null;

-- ── Prices: Rs per stock unit per product, month and shop (bill lots only) ────
-- Same rules as v_product_price: lots from bills, not split copies, purchase not taken back.
create view public.v_product_price_month
with (security_invoker = true) as
  select l.household_id, l.product_id, p.name as product_name, p.category_id,
         date_trunc('month', t.occurred_on)::date as month,
         t.merchant_id, coalesce(m.name, t.payee_text) as merchant_name,
         sum(l.qty_initial) as qty,
         round(sum(l.qty_initial * l.unit_cost), 2) as spent,
         round(sum(l.qty_initial * l.unit_cost) / nullif(sum(l.qty_initial), 0), 4) as unit_cost,
         count(*)::integer as lots,
         u.code as unit_code
    from public.stock_lot l
    join public.product p on p.id = l.product_id and p.household_id = l.household_id
    join public.unit u on u.id = p.stock_unit_id
    join public.transaction_line tl on tl.id = l.transaction_line_id and tl.household_id = l.household_id
    join public.money_transaction t on t.id = tl.transaction_id and t.household_id = tl.household_id
    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
   where l.split_from_id is null and l.unit_cost is not null and l.qty_initial > 0
     and not private.lot_purchase_undone(l.id)
   group by l.household_id, l.product_id, p.name, p.category_id, date_trunc('month', t.occurred_on),
            t.merchant_id, coalesce(m.name, t.payee_text), u.code;

-- ── Pantry: bought / consumed / wasted per product and month ──────────────────
-- Undone movements (and the undo rows themselves) don't count. Purchases count in the month the
-- lot was bought; the rest in the (household-local) month they happened.
create view public.v_stock_flow_month
with (security_invoker = true) as
  select m.household_id, m.product_id, p.name as product_name, p.category_id,
         coalesce(c.parent_id, c.id) as top_category_id,
         date_trunc('month', case when m.reason = 'purchase' then coalesce(k.purchased_on, (m.created_at at time zone h.timezone)::date)
                                  else (m.created_at at time zone h.timezone)::date end)::date as month,
         case m.reason when 'purchase' then 'bought' when 'consume' then 'consumed' else 'wasted' end as flow,
         sum(abs(m.delta)) as qty,
         round(sum(abs(m.delta) * coalesce(m.unit_cost, 0)), 2) as value,
         count(*)::integer as movements,
         u.code as unit_code
    from public.stock_movement m
    join public.household h on h.id = m.household_id
    join public.product p on p.id = m.product_id and p.household_id = m.household_id
    join public.unit u on u.id = p.stock_unit_id
    join public.stock_lot k on k.id = m.lot_id and k.household_id = m.household_id
    left join public.category c on c.id = p.category_id and c.household_id = p.household_id
   where m.reason in ('purchase', 'consume', 'waste')
     and not exists (select 1 from public.stock_movement r where r.reverses_id = m.id)
   group by 1, 2, 3, 4, 5, 6, 7, 11;

-- ── Pantry: how fast each product is used, and when it runs out ───────────────
-- rate = consumed in the last 90 days ÷ days since the first of those uses (at least 14, at most 90)
create view public.v_product_velocity
with (security_invoker = true) as
  select p.id as product_id, p.household_id, p.name as product_name, p.min_qty,
         s.qty, s.qty_effective, s.below_min,
         u.code as unit_code,
         c.used_30, c.used_90, c.first_used_on, c.last_used_on,
         r.rate as per_day,
         case when r.rate > 0 then floor(s.qty_effective / r.rate)::integer end as days_to_empty
    from public.product p
    join public.household h on h.id = p.household_id
    join public.unit u on u.id = p.stock_unit_id
    join public.v_product_stock s on s.product_id = p.id and s.household_id = p.household_id
    cross join lateral (select (now() at time zone h.timezone)::date as today) z
    cross join lateral (
      select coalesce(sum(-m.delta) filter (where m.created_at >= now() - interval '30 days'), 0) as used_30,
             coalesce(sum(-m.delta), 0) as used_90,
             min((m.created_at at time zone h.timezone)::date) as first_used_on,
             max((m.created_at at time zone h.timezone)::date) as last_used_on
        from public.stock_movement m
       where m.household_id = p.household_id and m.product_id = p.id and m.reason = 'consume'
         and m.created_at >= now() - interval '90 days'
         and not exists (select 1 from public.stock_movement x where x.reverses_id = m.id)
    ) c
    cross join lateral (
      select case when c.used_90 > 0
                  then round(c.used_90 / least(greatest(z.today - c.first_used_on + 1, 14), 90), 4)
             end as rate
    ) r
   where not p.archived and c.used_90 > 0;

-- ── Utilities: Rs, units and Rs per unit per payment ──────────────────────────
create view public.v_utility_usage
with (security_invoker = true) as
  select r.household_id, r.id as recurring_id, r.name as rule_name, r.usage_unit,
         t.id as transaction_id, t.recurring_period as period, t.occurred_on, t.total as amount,
         mr.id as reading_id, mr.units, mr.meter_value,
         case when mr.units > 0 then round(t.total / mr.units, 2) end as per_unit
    from public.recurring_rule r
    join public.money_transaction t on t.household_id = r.household_id and t.recurring_id = r.id
    left join public.meter_reading mr on mr.transaction_id = t.id and mr.household_id = t.household_id;

-- ── Places: what each place holds, its value, and when anything there last moved ─
create view public.v_location_contents
with (security_invoker = true) as
  select l.id as location_id, l.household_id, l.name, l.path, l.parent_id,
         coalesce(st.lots, 0) as lots,
         coalesce(st.products, 0) as products,
         coalesce(st.value, 0) as stock_value,
         coalesce(ast.assets, 0) as assets,
         coalesce(ast.value, 0) as asset_value,
         greatest(st.last_moved, ast.last_changed) as last_touched,
         coalesce(st.stale_lots, 0) as stale_lots,
         coalesce(ast.stale_assets, 0) as stale_assets
    from public.location l
    left join lateral (
      select count(*)::integer as lots, count(distinct k.product_id)::integer as products,
             round(sum(k.qty_remaining * coalesce(k.unit_cost, 0)), 2) as value,
             max(lm.last_at) as last_moved,
             count(*) filter (where lm.last_at < now() - interval '365 days')::integer as stale_lots
        from public.stock_lot k
        left join lateral (
          select max(m.created_at) as last_at from public.stock_movement m
           where m.household_id = k.household_id and m.lot_id = k.id
        ) lm on true
       where k.household_id = l.household_id and k.location_id = l.id and k.qty_remaining > 0
    ) st on true
    left join lateral (
      select count(*)::integer as assets, coalesce(sum(v.current_value), 0) as value,
             max(v.updated_at) as last_changed,
             count(*) filter (where v.updated_at < now() - interval '365 days')::integer as stale_assets
        from public.v_asset v
       where v.household_id = l.household_id and v.location_id = l.id
         and v.status not in ('sold', 'disposed', 'lost')
    ) ast on true;

revoke all on public.v_spend_line, public.v_account_month_end, public.v_product_price_month,
              public.v_stock_flow_month, public.v_product_velocity, public.v_utility_usage,
              public.v_location_contents from anon, authenticated;
grant select on public.v_spend_line, public.v_account_month_end, public.v_product_price_month,
               public.v_stock_flow_month, public.v_product_velocity, public.v_utility_usage,
               public.v_location_contents to authenticated;
revoke execute on function public.insights_spend(uuid, jsonb) from public, anon;
grant execute on function public.insights_spend(uuid, jsonb) to authenticated;

update public.app_meta set value = '45' where key = 'schema_version';
