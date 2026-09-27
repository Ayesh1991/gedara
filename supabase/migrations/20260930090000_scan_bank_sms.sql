-- Phase 7c · 59 — bank SMS screenshots from the Bill Scanner (MASTER_PLAN §7, Phase 2b inbox)
-- When the phone's forwarder misses an alert, a screenshot of the bank's SMS thread goes through the
-- claude.ai Bill Scanner project, which saves `"doc_type": "bank_sms"` JSON into the same Drive folder.
-- drive-scan lists it like any scanned file; the web app adds the alerts to the SMS review inbox
-- (sms-ingest, as for a backup file) and marks the file done here. Nothing reaches the ledger by
-- itself: every alert is still reviewed by a person.

alter table public.scan_file drop constraint scan_file_doc_type_check;
alter table public.scan_file
  add constraint scan_file_doc_type_check check (doc_type in ('bill', 'warranty', 'rating_plate', 'bank_sms'));

-- When a bank_sms file's alerts were added to the inbox (bills and cards have their own evidence).
alter table public.scan_file add column imported_at timestamptz;

create or replace view public.v_scan_file
with (security_invoker = true)
as
select f.id, f.household_id, f.drive_file_id, f.name, f.mime, f.modified_at, f.doc_type, f.payload,
       f.bill_fps, f.parse_error, f.asset_id, f.ignored_at, f.seen_at,
       cardinality(f.bill_fps) as bills_total,
       b.imported as bills_imported,
       case
         when f.ignored_at is not null then 'ignored'
         when f.payload is null then 'error'
         when f.doc_type = 'bill' and b.imported >= cardinality(f.bill_fps) then 'imported'
         when f.doc_type = 'bank_sms' and f.imported_at is not null then 'imported'
         when f.doc_type in ('warranty', 'rating_plate') and f.asset_id is not null then 'imported'
         else 'waiting'
       end as status,
       f.imported_at
  from public.scan_file f
  cross join lateral (
    select count(*)::integer as imported
      from unnest(f.bill_fps) fp
     where exists (select 1 from public.money_transaction t
                    where t.household_id = f.household_id and t.fingerprint = fp)
  ) b;

-- The alerts of a bank_sms file are in the inbox (p_done false = take the mark back).
create function public.rpc_scan_file_done(p_file uuid, p_done boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_type      text;
begin
  select f.household_id, f.doc_type into v_household, v_type from public.scan_file f where f.id = p_file;
  if v_household is null or not private.is_member(v_household) then
    raise exception 'unknown file' using errcode = '23503';
  end if;
  if not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_type is distinct from 'bank_sms' then
    raise exception 'only bank SMS files are marked this way' using errcode = '23514';
  end if;
  update public.scan_file f set imported_at = case when p_done then now() end where f.id = p_file;
end;
$$;

revoke execute on function public.rpc_scan_file_done(uuid, boolean) from public, anon;
grant execute on function public.rpc_scan_file_done(uuid, boolean) to authenticated;

update public.app_meta set value = '59' where key = 'schema_version';
