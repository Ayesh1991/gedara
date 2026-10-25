-- Phase 9 · 91 — "Same alert twice" in Check past bookings (9b.2 fix).
--
-- A bank sometimes sends an alert twice (Sampath, 26 seconds apart), or a backup holds a copy received
-- days later (BOC, 12 days later): same sender, kind, amount and balance — one event. Booked separately,
-- the second copy counted the money twice (prod, 2026-10-25: Rs 20,000 and Rs 25,000 card payments).
--   * match_suggestion gains the task sms_duplicate;
--   * rpc_sms_drop_duplicate removes the entry made only from the copies and marks the copies seen, in one
--     step, after checking that each copy really is the same event as an alert that is kept.

alter table public.match_suggestion drop constraint match_suggestion_task_check;
alter table public.match_suggestion add constraint match_suggestion_task_check
  check (task in ('line_product', 'line_category', 'line_thing', 'sms_category', 'sms_link', 'sms_rebook', 'sms_recategorise',
                  'sms_topup', 'sms_duplicate'));

-- p: { keep_sms: [uuid], drop_sms: [uuid], delete_tx: uuid | null }
-- Every dropped alert must match a kept one (sender, kind, amount, balance after; balance known); the entry
-- deleted must be made only of dropped alerts and must not be the kept alerts' entry.
create function public.rpc_sms_drop_duplicate(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep      uuid[] := array(select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p -> 'keep_sms', '[]')));
  v_drop      uuid[] := array(select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p -> 'drop_sms', '[]')));
  v_tx        uuid := (p ->> 'delete_tx')::uuid;
  v_household uuid;
  v_d         public.sms_message;
begin
  if cardinality(v_keep) = 0 or cardinality(v_drop) = 0 or v_keep && v_drop then
    raise exception 'say which alerts to keep and which copies to drop' using errcode = '22023';
  end if;
  select s.household_id into v_household from public.sms_message s where s.id = v_drop[1];
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (select count(*) from public.sms_message s where s.id = any (v_keep || v_drop) and s.household_id = v_household)
     <> cardinality(v_keep) + cardinality(v_drop) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  for v_d in select * from public.sms_message s where s.id = any (v_drop) loop
    if v_d.balance_after is null or v_d.amount is null or not exists (
         select 1 from public.sms_message k
          where k.id = any (v_keep) and k.sender = v_d.sender and k.kind = v_d.kind
            and k.amount = v_d.amount and k.balance_after = v_d.balance_after) then
      raise exception 'not the same alert' using errcode = '23514';
    end if;
  end loop;

  if v_tx is not null then
    if exists (select 1 from public.sms_message s where s.transaction_id = v_tx and not (s.id = any (v_drop)))
       or exists (select 1 from public.sms_message s where s.id = any (v_keep) and s.transaction_id = v_tx)
       or not exists (select 1 from public.money_transaction t where t.id = v_tx and t.household_id = v_household) then
      raise exception 'only an entry made from the copies can go' using errcode = '23514';
    end if;
    perform public.rpc_delete_transaction(v_tx, false);
  end if;

  update public.sms_message s set ignored = true
   where s.id = any (v_drop) and s.transaction_id is null;
  return jsonb_build_object('dropped', cardinality(v_drop), 'deleted', v_tx);
end;
$$;

revoke execute on function public.rpc_sms_drop_duplicate(jsonb) from public, anon;
grant execute on function public.rpc_sms_drop_duplicate(jsonb) to authenticated;

update public.app_meta set value = '91' where key = 'schema_version';
