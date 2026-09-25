-- Phase 4 · 29 — the spine's link (MASTER_PLAN §1): a bill line knows the product it bought
-- `transaction_line.product_id` is set by the routing RPCs (migration 31) when a line becomes stock;
-- its lots point back with `stock_lot.transaction_line_id` (migration 25). Asset lines get their
-- link in Phase 5, when the `asset` table exists.

alter table public.transaction_line add column product_id uuid;

alter table public.transaction_line
  add constraint transaction_line_product_fk foreign key (household_id, product_id)
  references public.product (household_id, id) on delete set null (product_id);

create index transaction_line_product_idx on public.transaction_line (household_id, product_id)
  where product_id is not null;

-- One row per bill line: where it went. Lots include parts split off later (opened / moved), which
-- keep the line they came from.
create view public.v_line_route
with (security_invoker = true) as
  select l.id as line_id, l.household_id, l.transaction_id, l.line_no, l.destiny, l.product_id,
         p.name as product_name, u.code as stock_unit_code,
         coalesce(s.lots, 0) as lots,
         s.qty_initial, s.qty_remaining, s.first_lot_id
    from public.transaction_line l
    left join public.product p on p.id = l.product_id and p.household_id = l.household_id
    left join public.unit u on u.id = p.stock_unit_id
    left join lateral (
      select count(*)::integer as lots,
             sum(k.qty_initial) filter (where k.split_from_id is null) as qty_initial,
             sum(k.qty_remaining) as qty_remaining,
             (array_agg(k.id order by k.created_at, k.id))[1] as first_lot_id
        from public.stock_lot k
       where k.household_id = l.household_id and k.transaction_line_id = l.id
    ) s on true;

revoke all on public.v_line_route from anon, authenticated;
grant select on public.v_line_route to authenticated;

update public.app_meta set value = '29' where key = 'schema_version';
