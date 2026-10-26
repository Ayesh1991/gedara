-- Phase 9 · 92 — "Booked twice: the alert and the scanned bill" in Check past bookings (9b.2 fix).
--
-- A card charge or a BOC Flex Tap & Pay alert saved as its own expense while the scanned bill for the same
-- purchase waits in the "to be matched" account counts the money twice in spending (prod, 2026-10-26:
-- Cargills Rs 5,066.26, Gunasekara Rs 2,252). The bill is the better record (its items), so:
--   * match_suggestion gains the task sms_relink;
--   * rpc_sms_relink removes the entry made from the alert and links the alert to the bill — which moves
--     the bill to the alert's account (rpc_sms_link) — in one step.

alter table public.match_suggestion drop constraint match_suggestion_task_check;
alter table public.match_suggestion add constraint match_suggestion_task_check
  check (task in ('line_product', 'line_category', 'line_thing', 'sms_category', 'sms_link', 'sms_rebook', 'sms_recategorise',
                  'sms_topup', 'sms_duplicate', 'sms_relink'));

-- p: { sms_ids: [uuid], delete_tx: uuid, bill_tx: uuid }
create function public.rpc_sms_relink(p jsonb)
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
     or not exists (select 1 from public.account a where a.id = v_bill.account_id and a.is_suspense)
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

revoke execute on function public.rpc_sms_relink(jsonb) from public, anon;
grant execute on function public.rpc_sms_relink(jsonb) to authenticated;

update public.app_meta set value = '92' where key = 'schema_version';
