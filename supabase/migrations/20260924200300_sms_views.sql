-- Phase 2b · 21 — "Bank says" vs "Gedara says"
-- The latest balance a bank alert reported for each account (BOC: balance available; cards:
-- available credit), next to what Gedara computes (v_account_balance). A difference means a missed
-- alert, a pending card hold, or a transaction not entered yet. Never stored (CLAUDE.md rule 1).

create view public.v_sms_balance_check
with (security_invoker = true) as
  select a.id as account_id,
         a.household_id,
         s.balance_after as bank_reported,
         s.received_at as reported_at,
         s.id as sms_id,
         case when a.credit_limit is not null then b.available else b.balance end as gedara_value,
         b.is_set_up
    from public.account a
    join lateral (
      select m.id, m.balance_after, m.received_at
        from public.sms_message m
       where m.household_id = a.household_id and m.account_id = a.id and m.balance_after is not null
       order by m.received_at desc
       limit 1
    ) s on true
    join public.v_account_balance b on b.account_id = a.id and b.household_id = a.household_id;

revoke all on public.v_sms_balance_check from anon, authenticated;
grant select on public.v_sms_balance_check to authenticated;

update public.app_meta set value = '21' where key = 'schema_version';
