-- Phase 4 · 32 — what the spine makes visible: prices by shop, the shopping list with context
-- security_invoker: every view runs with the caller's RLS.

-- A lot whose purchase was taken back (undo, or its bill deleted) is not a price anyone paid.
create function private.lot_purchase_undone(p_lot uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.stock_movement pm
      join public.stock_movement u on u.reverses_id = pm.id
     where pm.lot_id = p_lot and pm.reason = 'purchase')
$$;

grant execute on function private.lot_purchase_undone(uuid) to authenticated;

-- Price per stock unit by product × shop, from lots bought on bills (MASTER_PLAN §5.2 "price per kg
-- by merchant", §4 row 4 "cheapest recent merchant"). merchant_id is null for bills without a shop.
create view public.v_product_price
with (security_invoker = true) as
  select l.household_id, l.product_id, t.merchant_id, m.name as merchant_name,
         count(*)::integer as times,
         max(t.occurred_on) as last_bought_on,
         (array_agg(l.unit_cost order by t.occurred_on desc, t.occurred_at desc nulls last, l.created_at desc))[1]
           as last_unit_cost,
         min(l.unit_cost) filter (where t.occurred_on >= current_date - 180) as min_unit_cost_180d
    from public.stock_lot l
    join public.transaction_line tl on tl.id = l.transaction_line_id and tl.household_id = l.household_id
    join public.money_transaction t on t.id = tl.transaction_id and t.household_id = tl.household_id
    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
   where l.split_from_id is null and l.unit_cost is not null
     and not private.lot_purchase_undone(l.id)
   group by l.household_id, l.product_id, t.merchant_id, m.name;

-- The list with everything a phone in the shop needs on one row.
create view public.v_shopping_list
with (security_invoker = true) as
  select i.id, i.household_id, i.list, i.product_id, i.free_text, i.qty, i.unit_id, i.source, i.note,
         i.done, i.done_at, i.done_by, i.done_by_line, i.dismissed, i.created_by, i.created_at, i.updated_at,
         p.name as product_name, p.stock_unit_id, su.code as stock_unit_code, u.code as unit_code,
         ps.qty as stock_qty, ps.below_min, p.min_qty,
         best.merchant_name as best_merchant, best.last_unit_cost as best_unit_cost,
         best.last_bought_on as best_bought_on,
         bt.id as bought_transaction_id, bt.occurred_on as bought_on,
         coalesce(bm.name, bt.payee_text) as bought_at
    from public.shopping_list_item i
    left join public.product p on p.id = i.product_id and p.household_id = i.household_id
    left join public.unit su on su.id = p.stock_unit_id
    left join public.unit u on u.id = i.unit_id
    left join public.v_product_stock ps on ps.product_id = i.product_id
    left join lateral (
      select pp.merchant_name, pp.last_unit_cost, pp.last_bought_on
        from public.v_product_price pp
       where pp.product_id = i.product_id and pp.household_id = i.household_id
         and pp.merchant_id is not null and pp.last_bought_on >= current_date - 180
       order by pp.last_unit_cost, pp.last_bought_on desc
       limit 1
    ) best on true
    left join public.transaction_line tl on tl.id = i.done_by_line and tl.household_id = i.household_id
    left join public.money_transaction bt on bt.id = tl.transaction_id and bt.household_id = tl.household_id
    left join public.merchant bm on bm.id = bt.merchant_id and bm.household_id = bt.household_id;

-- v_product_stock (migration 27): "last price" skips lots whose purchase was taken back.
create or replace view public.v_product_stock
with (security_invoker = true) as
  select p.id as product_id,
         p.household_id,
         coalesce(s.qty, 0) as qty,
         coalesce(s.qty_opened, 0) as qty_opened,
         -- What counts towards "enough": opened stock doesn't when the product says so.
         coalesce(s.qty, 0) - case when p.treat_opened_as_out then coalesce(s.qty_opened, 0) else 0 end as qty_effective,
         s.next_due,
         coalesce(s.value, 0) as value,
         coalesce(s.lots, 0) as lots,
         coalesce(s.unpriced_qty, 0) as unpriced_qty,
         (p.min_qty is not null
            and coalesce(s.qty, 0) - case when p.treat_opened_as_out then coalesce(s.qty_opened, 0) else 0 end < p.min_qty)
           as below_min,
         c.unit_cost as last_unit_cost
    from public.product p
    left join lateral (
      select sum(l.qty_remaining) as qty,
             sum(l.qty_remaining) filter (where l.opened_at is not null) as qty_opened,
             min(l.due_date) as next_due,
             round(sum(l.qty_remaining * coalesce(l.unit_cost, 0)), 2) as value,
             count(*)::integer as lots,
             sum(l.qty_remaining) filter (where l.unit_cost is null) as unpriced_qty
        from public.stock_lot l
       where l.product_id = p.id and l.household_id = p.household_id and l.qty_remaining > 0
    ) s on true
    left join lateral (
      select l.unit_cost from public.stock_lot l
       where l.product_id = p.id and l.household_id = p.household_id and l.unit_cost is not null
         and not private.lot_purchase_undone(l.id)
       order by l.purchased_on desc nulls last, l.created_at desc
       limit 1
    ) c on true;

revoke all on public.v_product_price, public.v_shopping_list from anon, authenticated;
grant select on public.v_product_price, public.v_shopping_list to authenticated;

update public.app_meta set value = '32' where key = 'schema_version';
