-- Phase 6 · 46 — the Attention feed (MASTER_PLAN §4 row 7, §5.2 Home)
-- ONE definition of "what needs attention", used by the app (attention_feed) and by the daily push
-- (rpc_push_digest, migration 47), so the phone notification and Home can never disagree.
--
-- kind               severity   when
-- expired            red        a product's earliest lot is past its expiry date
-- best_before_passed amber      … past its best-before date
-- due_soon           cyan       … due within 5 days (the Pantry chip's threshold)
-- below_min          violet     below its minimum (and not "Not now" on the shopping list)
-- runs_out           violet     used up in < 5 days at the current rate (not already below min)
-- bill_due / insurance_due  cyan, red when overdue   within the rule's notify_days_before
-- warranty_ending    cyan       warranty ends within 30 days
-- service_due        cyan, amber when overdue        within the plan's notify_days_before
-- things_pending     violet     Things bought on bills, not entered yet (one row, with the count)
-- sms_review         violet     bank alerts waiting in the inbox (one row, with the count)
-- budget_near / budget_over  amber / red              ≥ 90 % / > 100 % of this month's budget
--
-- item_key is deterministic and changes when the situation changes (new due date, new stock, new
-- count), so "hide until it changes" is simply a dismissal without an end date.

create table public.attention_dismissal (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  item_key     text not null check (length(item_key) between 3 and 200),
  hidden_until date,                                    -- null = until the item changes
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (household_id, item_key)
);

create index attention_dismissal_created_by_idx on public.attention_dismissal (created_by);

alter table public.attention_dismissal enable row level security;

revoke all on table public.attention_dismissal from anon, authenticated;
grant select, delete on table public.attention_dismissal to authenticated;
grant insert (id, household_id, item_key, hidden_until) on table public.attention_dismissal to authenticated;
grant update (hidden_until) on table public.attention_dismissal to authenticated;

create policy attention_dismissal_select on public.attention_dismissal for select to authenticated
  using (private.is_member(household_id));
create policy attention_dismissal_insert on public.attention_dismissal for insert to authenticated
  with check (private.can_write(household_id));
create policy attention_dismissal_update on public.attention_dismissal for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy attention_dismissal_delete on public.attention_dismissal for delete to authenticated
  using (private.can_write(household_id));

-- ── The items ─────────────────────────────────────────────────────────────────
-- SECURITY DEFINER with an explicit household filter; never granted to clients (attention_feed
-- checks membership first; the push digest runs as service_role).
create function private.attention_items(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with d as (select private.household_today(p_household) as today),
  last_lot as (
    select k.product_id, extract(epoch from max(k.created_at))::bigint::text as stamp
      from public.stock_lot k where k.household_id = p_household group by k.product_id
  ),
  pantry as (
    select p.id, p.name, p.due_type, s.qty, s.qty_effective, s.next_due, s.below_min, u.code as unit,
           coalesce(ll.stamp, '0') as stamp
      from public.product p
      join public.v_product_stock s on s.product_id = p.id and s.household_id = p.household_id
      join public.unit u on u.id = p.stock_unit_id
      left join last_lot ll on ll.product_id = p.id
     where p.household_id = p_household and not p.archived
  )
  -- Pantry dates
  select 'lot:' || x.id || ':' || x.next_due || ':' || x.k, x.k,
         case x.k when 'expired' then 'red' when 'best_before_passed' then 'amber' else 'cyan' end,
         'product', x.id, x.name, x.next_due, x.next_due - d.today, null::numeric, x.qty, x.unit, '{}'::jsonb
    from d, lateral (
      select pa.*, case when pa.next_due < d.today and pa.due_type = 'expiry' then 'expired'
                        when pa.next_due < d.today then 'best_before_passed'
                        when pa.next_due - d.today <= 5 then 'due_soon' end as k
        from pantry pa
       where pa.due_type <> 'none' and pa.qty > 0 and pa.next_due is not null
    ) x
   where x.k is not null

  union all
  -- Below minimum (respecting "Not now" on the shopping list)
  select 'min:' || pa.id || ':' || pa.stamp, 'below_min', 'violet', 'product', pa.id, pa.name, null, null,
         null, pa.qty, pa.unit, '{}'::jsonb
    from pantry pa
   where pa.below_min
     and not exists (select 1 from public.shopping_list_item i
                      where i.household_id = p_household and i.product_id = pa.id and i.dismissed and not i.done)

  union all
  -- Runs out soon at the current rate
  select 'runout:' || v.product_id || ':' || pa.stamp, 'runs_out', 'violet', 'product', v.product_id, v.product_name,
         d.today + v.days_to_empty, v.days_to_empty, null, v.qty, v.unit_code,
         jsonb_build_object('per_day', v.per_day)
    from d, public.v_product_velocity v
    join pantry pa on pa.id = v.product_id
   where v.household_id = p_household and not v.below_min and v.qty_effective > 0 and v.days_to_empty < 5

  union all
  -- Recurring bills and insurance renewals
  select 'bill:' || r.id || ':' || r.next_due,
         case when r.asset_id is not null or lower(coalesce(r.category_name, '')) = 'insurance'
              then 'insurance_due' else 'bill_due' end,
         case when r.days_left < 0 then 'red' else 'cyan' end,
         'recurring', r.id, r.name, r.next_due, r.days_left, coalesce(r.expected_amount, r.last_amount), null, null,
         jsonb_build_object('type', r.type, 'asset_id', r.asset_id, 'asset_name', r.asset_name)
    from public.v_recurring_due r
   where r.household_id = p_household and r.active and r.days_left <= r.notify_days_before

  union all
  -- Warranties ending
  select 'warranty:' || a.id || ':' || a.warranty_until, 'warranty_ending', 'cyan', 'asset', a.id, a.name,
         a.warranty_until, a.warranty_days_left, null, null, null, jsonb_build_object('tag', a.tag)
    from public.v_asset a
   where a.household_id = p_household and a.status not in ('sold', 'disposed', 'lost')
     and a.warranty_days_left between 0 and 30

  union all
  -- Services due
  select 'service:' || m.id || ':' || m.next_due, 'service_due', case when m.days_left < 0 then 'amber' else 'cyan' end,
         'asset', m.asset_id, m.asset_name, m.next_due, m.days_left, null, null, null,
         jsonb_build_object('plan_id', m.id, 'plan_name', m.name)
    from public.v_maintenance_due m
   where m.household_id = p_household and m.active and m.next_due is not null
     and m.asset_status not in ('sold', 'disposed', 'lost') and m.days_left <= m.notify_days_before

  union all
  -- Things bought, not entered yet
  select 'things:' || count(*), 'things_pending', 'violet', 'queue', null, null, null, null,
         sum(q.amount), count(*), null, '{}'::jsonb
    from public.v_asset_pending_line q
   where q.household_id = p_household
  having count(*) > 0

  union all
  -- Bank alerts to review
  select 'sms:' || count(*) || ':' || extract(epoch from max(s.received_at))::bigint, 'sms_review', 'violet', 'queue',
         null, null, null, null, null, count(*), null, '{}'::jsonb
    from public.sms_message s
   where s.household_id = p_household and not s.ignored and s.transaction_id is null
  having count(*) > 0

  union all
  -- Budgets this month
  select 'budget:' || b.category_id || ':' || to_char(d.today, 'YYYY-MM') || ':'
           || case when b.spent > b.budget then 'over' else 'near' end,
         case when b.spent > b.budget then 'budget_over' else 'budget_near' end,
         case when b.spent > b.budget then 'red' else 'amber' end,
         'category', b.category_id, b.name, null, null, b.spent, null, null,
         jsonb_build_object('budget', b.budget, 'month', to_char(d.today, 'YYYY-MM'))
    from d, public.budget_month(p_household, d.today) b
   where b.budget is not null and b.spent >= b.budget * 0.9
$$;

-- What a household sees: not hidden, most urgent first.
create function private.attention_visible(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select i.*
    from private.attention_items(p_household) i
   where not exists (
     select 1 from public.attention_dismissal x
      where x.household_id = p_household and x.item_key = i.item_key
        and (x.hidden_until is null or x.hidden_until > private.household_today(p_household)))
   order by case i.severity when 'red' then 1 when 'amber' then 2 when 'cyan' then 3 else 4 end,
            i.days_left nulls last, i.title
$$;

revoke execute on function private.attention_items(uuid) from public, anon, authenticated;
revoke execute on function private.attention_visible(uuid) from public, anon, authenticated;

-- The app's entry point: members only (another household's id returns nothing).
create function public.attention_feed(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_household) then
    return;
  end if;
  return query select * from private.attention_visible(p_household);
end;
$$;

revoke execute on function public.attention_feed(uuid) from public, anon;
grant execute on function public.attention_feed(uuid) to authenticated;

update public.app_meta set value = '46' where key = 'schema_version';
