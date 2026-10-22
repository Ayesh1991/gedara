-- Phase 9 · 81 — acting on a matching suggestion, the Attention item, the twice-daily run.
--
--   * rpc_line_link_product: an old bill line gets its product WITHOUT new stock (the purchase was
--     used up long ago; "Send to pantry" still makes stock when wanted) and the bill name is learned;
--     or it is marked "not pantry" (destiny expense), also learned.
--   * rpc_line_category: a line's category changes (also on a bill that already fed the pantry — the
--     category moves no stock) and the bill name is learned (line_memory).
--   * attention_items gains match_review (suggestions waiting); housekeeping trims matching history.
--   * pg_cron 'gedara-match' calls the match-agent function at 12:30 and 21:30 Colombo (07:00 and
--     16:00 UTC): one request per run, nothing polls (Log Ingestion budget).

create function public.rpc_line_link_product(p_line uuid, p_product uuid, p_destiny text default 'stock')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.transaction_line;
  v_merchant uuid;
begin
  select * into v_line from public.transaction_line l where l.id = p_line for update;
  if not found or not private.can_write(v_line.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_destiny not in ('stock', 'expense') or (p_destiny = 'stock') <> (p_product is not null) then
    raise exception 'a pantry line needs a product, a not-pantry line none' using errcode = '22023';
  end if;
  if exists (select 1 from public.stock_lot k where k.household_id = v_line.household_id and k.transaction_line_id = v_line.id) then
    raise exception 'this line already feeds the pantry' using errcode = 'GDRTD';
  end if;
  if p_product is not null and not exists (select 1 from public.product p where p.id = p_product
       and p.household_id = v_line.household_id and not p.archived) then
    raise exception 'no such product' using errcode = '23503';
  end if;

  update public.transaction_line l set product_id = p_product, destiny = p_destiny where l.id = v_line.id;

  select t.merchant_id into v_merchant from public.money_transaction t
   where t.id = v_line.transaction_id and t.household_id = v_line.household_id;
  if private.bill_name_norm(v_line.raw_name) <> '' then
    insert into public.product_alias as a (household_id, alias_norm, destiny, product_id, merchant_id)
    values (v_line.household_id, left(private.bill_name_norm(v_line.raw_name), 200), p_destiny, p_product, v_merchant)
    on conflict (household_id, alias_norm) do update
      set destiny = excluded.destiny, product_id = excluded.product_id, merchant_id = coalesce(excluded.merchant_id, a.merchant_id),
          hits = a.hits + 1, last_used_at = now();
  end if;
end;
$$;

create function public.rpc_line_category(p_line uuid, p_category uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.transaction_line;
begin
  select * into v_line from public.transaction_line l where l.id = p_line for update;
  if not found or not private.can_write(v_line.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.category c where c.id = p_category and c.household_id = v_line.household_id
                   and c.kind in ('expense', 'both')) then
    raise exception 'no such category' using errcode = '23503';
  end if;
  update public.transaction_line l set category_id = p_category where l.id = v_line.id;
  if private.bill_name_norm(v_line.raw_name) <> '' then
    insert into public.line_memory as m (household_id, name_norm, category_id)
    values (v_line.household_id, left(private.bill_name_norm(v_line.raw_name), 200), p_category)
    on conflict (household_id, name_norm) do update
      set category_id = excluded.category_id, hits = m.hits + 1, last_used_at = now();
  end if;
end;
$$;

revoke execute on function public.rpc_line_link_product(uuid, uuid, text) from public, anon;
revoke execute on function public.rpc_line_category(uuid, uuid) from public, anon;
grant execute on function public.rpc_line_link_product(uuid, uuid, text) to authenticated;
grant execute on function public.rpc_line_category(uuid, uuid) to authenticated;

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
  -- Matching suggestions waiting for a person (Phase 9b, migration 81)
  select 'match:' || count(*) || ':' || extract(epoch from max(m.updated_at))::bigint, 'match_review', 'violet', 'queue',
         null, null, null, null, null, count(*), null, '{}'::jsonb
    from public.match_suggestion m
   where m.household_id = p_household and m.status = 'pending'
  having count(*) > 0

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

  -- Music speaker (Phase 7h)
  delete from public.media_command c where c.created_at < now() - interval '7 days';
  delete from public.device_pairing p where p.expires_at < now();
  delete from public.device_pair_attempt a where a.at < now() - interval '1 day';
  -- An upload abandoned halfway, and songs the speaker never collected.
  insert into public.media_inbox_trash (path, household_id)
  select t.inbox_path, t.household_id from public.media_track t
   where t.inbox_path is not null
     and ((t.state = 'uploading' and t.updated_at < now() - interval '1 day')
       or (t.state in ('waiting', 'downloading') and t.updated_at < now() - interval '3 days'))
  on conflict do nothing;
  delete from public.media_track t where t.state = 'uploading' and t.updated_at < now() - interval '1 day';
  update public.media_track t set state = 'failed', inbox_path = null,
         error = 'the speaker did not collect it within 3 days', updated_at = now()
   where t.state in ('waiting', 'downloading') and t.updated_at < now() - interval '3 days';

  -- Home Assistant bridge (Phase 8): 30 days of command history.
  delete from public.home_command c where c.created_at < now() - interval '30 days';

  -- Matching (Phase 9b): a year of AI usage (cost history), 90 days of runs, decided suggestions for
  -- 180 days (they are the accuracy record of daily use).
  delete from public.ai_usage u where u.at < now() - interval '400 days';
  delete from public.match_run r where r.started_at < now() - interval '90 days';
  delete from public.match_suggestion s where s.status in ('stale', 'rejected', 'accepted', 'changed')
     and s.updated_at < now() - interval '180 days';
  -- a run that never finished (the function was stopped) is closed
  update public.match_run r set finished_at = now(), stats = r.stats || '{"aborted": true}'
   where r.finished_at is null and r.started_at < now() - interval '1 hour';
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;

create function private.run_match_agent()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_token text := private.cron_token();
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  if v_url is null or v_token is null then
    raise notice 'match run skipped: Vault secret project_url (or the cron token) is missing';
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/match-agent',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Gedara-Cron', v_token),
    body := jsonb_build_object('run', 'cron'),
    timeout_milliseconds := 140000);
end;
$$;

revoke execute on function private.run_match_agent() from public, anon, authenticated;

select cron.schedule('gedara-match', '0 7,16 * * *', 'select private.run_match_agent()');

update public.app_meta set value = '81' where key = 'schema_version';
