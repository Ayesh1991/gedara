-- Phase 2 · 17 — computed balances + monthly figures (never stored; CLAUDE.md rule 1)
-- security_invoker: each view runs with the caller's RLS, so a member only ever sees their household.

-- How each transaction moves each account it touches.
create view public.v_account_effect
with (security_invoker = true) as
  select t.household_id, t.account_id, t.id as transaction_id, t.occurred_on,
         case t.type when 'expense' then -t.total when 'transfer' then -t.total else t.total end as effect
    from public.money_transaction t
  union all
  select t.household_id, t.to_account_id, t.id, t.occurred_on, t.total
    from public.money_transaction t
   where t.type = 'transfer';

-- balance = opening balance (at the end of opening_on) + everything after it.
-- Credit cards: negative = owed; available = limit + balance.
create view public.v_account_balance
with (security_invoker = true) as
  select a.id as account_id,
         a.household_id,
         a.opening_on is not null as is_set_up,
         a.opening_balance + coalesce(sum(e.effect) filter (where a.opening_on is null or e.occurred_on > a.opening_on), 0)
           as balance,
         case when a.credit_limit is not null then
           a.credit_limit + a.opening_balance
             + coalesce(sum(e.effect) filter (where a.opening_on is null or e.occurred_on > a.opening_on), 0)
         end as available,
         count(e.transaction_id)::integer as transaction_count,
         max(e.occurred_on) as last_on
    from public.account a
    left join public.v_account_effect e on e.account_id = a.id and e.household_id = a.household_id
   group by a.id;

-- Income vs spending per calendar month (transfers and balance adjustments are neither).
create view public.v_monthly_cashflow
with (security_invoker = true) as
  select t.household_id,
         date_trunc('month', t.occurred_on)::date as month,
         coalesce(sum(t.total) filter (where t.type = 'income'), 0) as income,
         coalesce(sum(t.total) filter (where t.type = 'expense'), 0)
           - coalesce(sum(t.total) filter (where t.type = 'refund'), 0) as spent,
         coalesce(sum(t.total) filter (where t.type = 'income'), 0)
           - coalesce(sum(t.total) filter (where t.type = 'expense'), 0)
           + coalesce(sum(t.total) filter (where t.type = 'refund'), 0) as net,
         count(*) filter (where t.type in ('expense', 'refund'))::integer as bills
    from public.money_transaction t
   where t.type in ('expense', 'income', 'refund')
   group by t.household_id, date_trunc('month', t.occurred_on);

-- Spending per category per month (refunds count against it), rolled up to the top level too.
create view public.v_spend_by_category_month
with (security_invoker = true) as
  select l.household_id,
         date_trunc('month', t.occurred_on)::date as month,
         coalesce(c.parent_id, c.id) as top_category_id,
         l.category_id,
         sum(case when t.type = 'refund' then -l.amount else l.amount end) as spent,
         count(*)::integer as lines
    from public.transaction_line l
    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
    left join public.category c on c.id = l.category_id and c.household_id = l.household_id
   where t.type in ('expense', 'refund')
   group by l.household_id, date_trunc('month', t.occurred_on), coalesce(c.parent_id, c.id), l.category_id;

revoke all on public.v_account_effect, public.v_account_balance, public.v_monthly_cashflow,
              public.v_spend_by_category_month from anon, authenticated;
grant select on public.v_account_effect, public.v_account_balance, public.v_monthly_cashflow,
               public.v_spend_by_category_month to authenticated;

update public.app_meta set value = '17' where key = 'schema_version';
