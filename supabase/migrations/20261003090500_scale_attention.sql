-- Phase 6b · 67 — the kitchen scale in the Attention feed, and housekeeping for its readings
-- attention_items (one definition for the app and the 07:00 push, migration 46/55) gains:
--   scale_decision  a jar came back heavier and nothing could be moved into it (Move / Count / Later)
--   scale_new_tag   tags the scale saw this week that aren't linked to a container yet
-- Housekeeping keeps 90 days of scale readings (the stock journal keeps everything) — except open
-- questions — and 30 days of device commands. Pruned device readings raise the device's seq_floor,
-- so a very late replay of a pruned reading is acknowledged, never applied twice.

create or replace function private.attention_items(p_household uuid)
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

  union all
  -- Scanned files from Drive waiting to be imported (Phase 7, migration 54)
  select 'scan:' || count(*) || ':' || extract(epoch from max(f.modified_at))::bigint, 'scan_waiting', 'violet',
         'queue', null, null, null, null, null, count(*), null, '{}'::jsonb
    from public.v_scan_file f
   where f.household_id = p_household and f.status = 'waiting'
  having count(*) > 0

  union all
  -- Kitchen scale: a jar came back heavier and nothing could be moved into it (Phase 6b, migration 67)
  select 'scale:' || r.id, 'scale_decision', 'violet', 'scale_reading', r.id, p.name, null, null, null,
         r.pending_g, 'g', jsonb_build_object('location_id', r.location_id, 'container', l.name)
    from public.scale_reading r
    join public.product p on p.id = r.product_id
    left join public.location l on l.id = r.location_id
   where r.household_id = p_household and r.status = 'needs_decision'

  union all
  -- Kitchen scale: tags it saw that aren't linked to a container yet (last 7 days)
  select 'scaletag:' || count(distinct r.uid) || ':' || extract(epoch from max(r.received_at))::bigint,
         'scale_new_tag', 'violet', 'queue', null, null, null, null, null, count(distinct r.uid), null, '{}'::jsonb
    from public.scale_reading r
   where r.household_id = p_household and r.status = 'unknown_tag' and r.received_at > now() - interval '7 days'
     and not exists (select 1 from public.nfc_tag t where t.household_id = r.household_id and t.uid = r.uid)
  having count(distinct r.uid) > 0

  union all
  -- No export for 30 days (or never); comes back every month until a backup is made
  select 'backup:' || coalesce(to_char(e.last_at, 'YYYY-MM-DD'), 'never') || ':' || to_char(d.today, 'YYYY-MM'),
         'backup_due', 'cyan', 'export', null, null, (e.last_at + interval '30 days')::date,
         ((e.last_at + interval '30 days')::date - d.today), null, null, null,
         jsonb_build_object('last_at', e.last_at)
    from d, lateral (select max(x.created_at) as last_at from public.export_run x where x.household_id = p_household) e
   where e.last_at is null or e.last_at < now() - interval '30 days'
$$;

revoke execute on function private.attention_items(uuid) from public, anon, authenticated;

create or replace function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.attention_dismissal d
   where (d.hidden_until is not null and d.hidden_until < current_date - 7)
      or (d.hidden_until is null and d.created_at < now() - interval '180 days');
  delete from public.push_run r where r.run_on < current_date - 180;
  delete from cron.job_run_details j where j.end_time < now() - interval '30 days';

  -- Kitchen scale (Phase 6b)
  update public.device d set seq_floor = greatest(d.seq_floor, x.max_seq)
    from (select s.device_id, max(s.seq) as max_seq
            from public.scale_reading s
            join public.device d2 on d2.id = s.device_id and s.epoch = d2.epoch
           where s.received_at < now() - interval '90 days' and s.status <> 'needs_decision'
           group by s.device_id) x
   where d.id = x.device_id;
  delete from public.scale_reading s
   where s.received_at < now() - interval '90 days' and s.status <> 'needs_decision';
  delete from public.device_command c where c.created_at < now() - interval '30 days';
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;

update public.app_meta set value = '67' where key = 'schema_version';
