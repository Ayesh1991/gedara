-- Phase 11 · 109 — the bin scanner in the Attention feed, and housekeeping for its scans
-- attention_items (one definition for the app and the 07:00 push) gains:
--   bin_unknown  barcodes the scanner read that no product has yet (link once, the scans are applied)
--   bin_waiting  scans waiting for a yes/no (a bill just added the same thing; kept while paused)
--   bin_paused   a scanner that was paused (by a person, or by the limits of migration 108)
-- Housekeeping keeps 90 days of scans (the stock journal keeps everything), except those still
-- waiting for a person. Pruned scans raise the scanner's seq_floor, so a very late resend of a
-- pruned scan is acknowledged, never applied twice.

alter function private.attention_items(uuid) rename to attention_items_v104;
revoke execute on function private.attention_items_v104(uuid) from public, anon, authenticated;

create function private.attention_items(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.attention_items_v104(p_household)
  union all
  select 'binunknown:' || count(distinct s.code) || ':' || extract(epoch from max(s.received_at))::bigint,
         'bin_unknown', 'violet', 'queue', null, null, null, null, null, count(distinct s.code), null, '{}'::jsonb
    from public.bin_scan s
   where s.household_id = p_household and s.status = 'unknown'
  having count(*) > 0
  union all
  select 'binwaiting:' || count(*) || ':' || extract(epoch from max(s.received_at))::bigint,
         'bin_waiting', 'violet', 'queue', null, null, null, null, null, count(*), null, '{}'::jsonb
    from public.bin_scan s
   where s.household_id = p_household and s.status in ('bill_guard', 'held')
  having count(*) > 0
  union all
  select 'binpaused:' || d.id || ':' || extract(epoch from d.paused_at)::bigint,
         'bin_paused', case when d.paused_reason = 'manual' then 'amber' else 'red' end, 'device', d.id, d.name,
         null, null, null, null, null, jsonb_build_object('reason', d.paused_reason)
    from public.device d
   where d.household_id = p_household and d.kind = 'scanner' and d.revoked_at is null and d.paused_at is not null
$$;

revoke execute on function private.attention_items(uuid) from public, anon, authenticated;

alter function private.housekeeping() rename to housekeeping_v104;
revoke execute on function private.housekeeping_v104() from public, anon, authenticated;

create function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.housekeeping_v104();
  update public.device d set seq_floor = greatest(d.seq_floor, x.max_seq)
    from (select s.device_id, max(s.seq) as max_seq
            from public.bin_scan s
            join public.device d2 on d2.id = s.device_id and s.epoch = d2.epoch
           where s.received_at < now() - interval '90 days' and s.status not in ('unknown', 'bill_guard', 'held')
           group by s.device_id) x
   where d.id = x.device_id;
  delete from public.bin_scan s
   where s.received_at < now() - interval '90 days' and s.status not in ('unknown', 'bill_guard', 'held');
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;

update public.app_meta set value = '109' where key = 'schema_version';
