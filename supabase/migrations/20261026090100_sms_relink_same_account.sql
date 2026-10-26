-- Phase 9 · 93 — "Booked twice" also when the scanned bill is already on the alert's account (9b.2 fix).
--
-- On prod the two scanned bills had been moved by hand from "to be matched" to the wallet while the
-- Tap & Pay alerts' own entries stayed: the same purchase twice on one account. rpc_sms_relink now also
-- accepts a bill on the same account as the entry that goes (then the link moves nothing).

create or replace function public.rpc_sms_relink(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids       uuid[] := array(select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p -> 'sms_ids', '[]')));
  v_del       public.money_transaction;
  v_bill      public.money_transaction;
begin
  select * into v_del from public.money_transaction t where t.id = (p ->> 'delete_tx')::uuid;
  if not found or not private.can_write(v_del.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_bill from public.money_transaction t where t.id = (p ->> 'bill_tx')::uuid and t.household_id = v_del.household_id;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if cardinality(v_ids) = 0
     or v_del.type <> 'expense' or v_del.source <> 'sms' or v_bill.type <> 'expense' or v_bill.id = v_del.id
     or v_bill.total <> v_del.total
     -- the bill waits in "to be matched", or already sits on the same account
     or not (v_bill.account_id = v_del.account_id
             or exists (select 1 from public.account a where a.id = v_bill.account_id and a.is_suspense))
     or exists (select 1 from public.sms_message s where s.transaction_id = v_bill.id)
     -- the entry that goes is made from exactly these alerts
     or exists (select 1 from public.sms_message s where s.transaction_id = v_del.id and not (s.id = any (v_ids)))
     or (select count(*) from public.sms_message s where s.id = any (v_ids) and s.transaction_id = v_del.id) <> cardinality(v_ids) then
    raise exception 'not the same purchase' using errcode = '23514';
  end if;

  perform public.rpc_delete_transaction(v_del.id, false);
  return public.rpc_sms_link(v_ids, v_bill.id);
end;
$$;

update public.app_meta set value = '93' where key = 'schema_version';
