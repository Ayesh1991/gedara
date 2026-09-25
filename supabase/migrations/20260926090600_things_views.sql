-- Phase 5 · 39 — what Things shows (MASTER_PLAN §5.2 Things, §6 Things row, §7e)
-- security_invoker: every view runs with the caller's RLS. Values are computed, never stored.
--
-- Value of a thing (straight-line depreciation, §3.5):
--   months owned = whole months from purchase to today (or to the sale / disposal day when sold)
--   book value   = price − (price − salvage) × min(months owned ÷ useful life, 1); = price without a life
--   current value = book value while the household still has it, 0 once sold / disposed / lost
--   cost of ownership = price + Σ maintenance − sale price; per month = ÷ max(months owned, 1)

create view public.v_asset
with (security_invoker = true) as
  select a.*,
         'A-' || lpad(a.asset_no::text, 4, '0') as tag,
         c.name as category_name,
         c.parent_id as category_parent_id,
         pc.name as category_parent_name,
         l.path as location_path,
         pa.name as parent_name,
         pa.asset_no as parent_asset_no,
         coalesce(ch.parts, 0) as parts,
         coalesce(tg.tag_ids, '{}') as tag_ids,
         coalesce(tg.tag_names, '{}') as tag_names,
         tl.transaction_id as bill_id,
         bt.occurred_on as bill_date,
         bt.payee_text as bill_payee,
         d.today,
         d.months_owned,
         v.book_value,
         case when a.status in ('sold', 'disposed', 'lost') then 0 else v.book_value end as current_value,
         coalesce(mt.maintenance_cost, 0) as maintenance_cost,
         mt.last_maintained_on,
         case when a.purchase_price is null then null
              else a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0) end
           as cost_of_ownership,
         case when a.purchase_price is null or d.months_owned is null then null
              else round((a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0))
                         / greatest(d.months_owned, 1), 2) end
           as cost_per_month,
         case when a.status = 'sold' and a.sold_price is not null and v.book_value is not null
              then a.sold_price - v.book_value end as sale_gain,
         case when a.lifetime_warranty or a.warranty_until is null then null
              else a.warranty_until - d.today end as warranty_days_left,
         pl.next_due
    from public.asset a
    join public.household h on h.id = a.household_id
    left join public.category c on c.id = a.category_id and c.household_id = a.household_id
    left join public.category pc on pc.id = c.parent_id and pc.household_id = c.household_id
    left join public.location l on l.id = a.location_id and l.household_id = a.household_id
    left join public.asset pa on pa.id = a.parent_id and pa.household_id = a.household_id
    left join public.transaction_line tl on tl.id = a.transaction_line_id and tl.household_id = a.household_id
    left join public.money_transaction bt on bt.id = tl.transaction_id and bt.household_id = tl.household_id
    cross join lateral (
      select (now() at time zone h.timezone)::date as today
    ) z
    cross join lateral (
      select z.today,
             case when a.purchased_on is null then null
                  else greatest(0,
                         (extract(year from age(coalesce(case when a.status in ('sold', 'disposed', 'lost')
                                                              then coalesce(a.sold_on, z.today) end, z.today),
                                                     a.purchased_on)) * 12
                        + extract(month from age(coalesce(case when a.status in ('sold', 'disposed', 'lost')
                                                               then coalesce(a.sold_on, z.today) end, z.today),
                                                      a.purchased_on)))::integer)
             end as months_owned
    ) d
    cross join lateral (
      select case
               when a.purchase_price is null then null
               when a.useful_life_months is null or d.months_owned is null then a.purchase_price
               else round(a.purchase_price
                          - (a.purchase_price - least(coalesce(a.salvage_value, 0), a.purchase_price))
                            * least(d.months_owned::numeric / a.useful_life_months, 1), 2)
             end as book_value
    ) v
    left join lateral (
      select count(*)::integer as parts from public.asset x
       where x.household_id = a.household_id and x.parent_id = a.id
    ) ch on true
    left join lateral (
      select array_agg(t.id order by lower(t.name)) as tag_ids, array_agg(t.name order by lower(t.name)) as tag_names
        from public.asset_tag at2 join public.tag t on t.id = at2.tag_id and t.household_id = at2.household_id
       where at2.asset_id = a.id and at2.household_id = a.household_id
    ) tg on true
    left join lateral (
      select sum(g.cost) as maintenance_cost, max(g.done_on) as last_maintained_on
        from public.maintenance_log g
       where g.asset_id = a.id and g.household_id = a.household_id
    ) mt on true
    left join lateral (
      select min(m.next_due) as next_due from public.maintenance_plan m
       where m.asset_id = a.id and m.household_id = a.household_id and m.active
    ) pl on true;

-- "Bought, not entered yet": Things lines of purchases that no asset points at.
create view public.v_asset_pending_line
with (security_invoker = true) as
  select l.id as line_id, l.household_id, l.transaction_id, l.line_no, l.raw_name, l.category_id,
         c.name as category_name, l.qty, l.unit_text, l.amount,
         t.occurred_on, t.occurred_at, t.payee_text, t.account_id, t.source
    from public.transaction_line l
    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
    left join public.category c on c.id = l.category_id and c.household_id = l.household_id
   where l.destiny = 'asset' and t.type = 'expense' and l.amount > 0
     and not exists (select 1 from public.asset a
                      where a.household_id = l.household_id and a.transaction_line_id = l.id);

-- Active plans with their thing and how far away they are.
create view public.v_maintenance_due
with (security_invoker = true) as
  select m.id, m.household_id, m.asset_id, m.name, m.category_id, m.every_days, m.every_usage, m.usage_unit,
         m.next_due, m.notify_days_before, m.active, m.notes,
         a.name as asset_name, a.asset_no, a.status as asset_status,
         g.last_done_on,
         m.next_due - (now() at time zone h.timezone)::date as days_left
    from public.maintenance_plan m
    join public.asset a on a.id = m.asset_id and a.household_id = m.household_id
    join public.household h on h.id = m.household_id
    left join lateral (
      select max(x.done_on) as last_done_on from public.maintenance_log x
       where x.plan_id = m.id and x.household_id = m.household_id
    ) g on true;

-- Settings › Storage: what the household's files take (§7e; Drive overflow comes later).
create view public.v_storage_usage
with (security_invoker = true) as
  select household_id, provider, kind, entity_type,
         count(*)::integer as files,
         coalesce(sum(bytes), 0)::bigint as bytes
    from public.attachment
   group by household_id, provider, kind, entity_type;

revoke all on public.v_asset, public.v_asset_pending_line, public.v_maintenance_due, public.v_storage_usage
  from anon, authenticated;
grant select on public.v_asset, public.v_asset_pending_line, public.v_maintenance_due, public.v_storage_usage
  to authenticated;

update public.app_meta set value = '39' where key = 'schema_version';
