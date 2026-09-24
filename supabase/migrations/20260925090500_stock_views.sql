-- Phase 3 · 27 — stock views (MASTER_PLAN §3.4: v_stock replaces the old `stock` table)
-- security_invoker: each view runs with the caller's RLS, so a member only ever sees their household.
-- Status chips (expired / best-before passed / due soon / below min / opened) are computed in the
-- web app from these raw fields, so their thresholds stay cheap to tune.

-- Per product and place.
create view public.v_stock
with (security_invoker = true) as
  select l.household_id, l.product_id, l.location_id,
         sum(l.qty_remaining) as qty,
         min(l.due_date) as next_due,
         round(sum(l.qty_remaining * coalesce(l.unit_cost, 0)), 2) as value,
         bool_or(l.opened_at is not null) as any_opened,
         count(*)::integer as lots
    from public.stock_lot l
   where l.qty_remaining > 0
   group by l.household_id, l.product_id, l.location_id;

-- Per product (every product, also those with nothing in stock).
create view public.v_product_stock
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
       order by l.purchased_on desc nulls last, l.created_at desc
       limit 1
    ) c on true;

-- The journal: one row per movement, with names for display and whether it was undone.
create view public.v_stock_journal
with (security_invoker = true) as
  select m.id, m.seq, m.household_id, m.correlation_id, m.created_at, m.reason, m.delta, m.unit_cost,
         m.lot_id, m.product_id, p.name as product_name, u.code as unit_code,
         m.location_id, loc.path as location_path, m.meta, m.note, m.reverses_id,
         m.actor, hm.display_name as actor_name,
         exists (select 1 from public.stock_movement r where r.reverses_id = m.id) as undone
    from public.stock_movement m
    join public.product p on p.id = m.product_id and p.household_id = m.household_id
    join public.unit u on u.id = p.stock_unit_id
    left join public.location loc on loc.id = m.location_id and loc.household_id = m.household_id
    left join public.household_member hm on hm.household_id = m.household_id and hm.user_id = m.actor;

revoke all on public.v_stock, public.v_product_stock, public.v_stock_journal from anon, authenticated;
grant select on public.v_stock, public.v_product_stock, public.v_stock_journal to authenticated;

update public.app_meta set value = '27' where key = 'schema_version';
