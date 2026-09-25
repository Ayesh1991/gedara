-- Phase 6 · 43 — monthly budgets per main category (MASTER_PLAN §3.6 budget; Didula 2026-09-25)
-- A row sets a main category's budget FROM its month on: the budget for month M is the latest row
-- on or before M (so it carries over until changed); amount 0 = no budget from that month.
-- Budgets aren't balances, so they are plain table writes under RLS (can_write).

create table public.budget (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  category_id  uuid not null,
  month        date not null check (extract(day from month) = 1),
  amount       numeric(14,2) not null check (amount >= 0),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, category_id, month),
  foreign key (household_id, category_id) references public.category (household_id, id) on delete cascade
);

create index budget_category_idx on public.budget (household_id, category_id, month desc);
create index budget_created_by_idx on public.budget (created_by);

-- First of the month; main spending categories only.
create function private.budget_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cat public.category%rowtype;
begin
  new.month := date_trunc('month', new.month)::date;
  select c.* into v_cat from public.category c where c.id = new.category_id and c.household_id = new.household_id;
  if found and v_cat.parent_id is not null then
    raise exception 'budgets are for main categories' using errcode = '23514';
  end if;
  if found and v_cat.kind = 'income' then
    raise exception 'budgets are for spending categories' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger budget_check
  before insert or update on public.budget
  for each row execute function private.budget_check();

create trigger budget_updated_at
  before update on public.budget
  for each row execute function private.set_updated_at();

alter table public.budget enable row level security;

revoke all on table public.budget from anon, authenticated;
grant select, delete on table public.budget to authenticated;
grant insert (id, household_id, category_id, month, amount) on table public.budget to authenticated;
grant update (amount) on table public.budget to authenticated;

create policy budget_select on public.budget for select to authenticated
  using (private.is_member(household_id));
create policy budget_insert on public.budget for insert to authenticated
  with check (private.can_write(household_id));
create policy budget_update on public.budget for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy budget_delete on public.budget for delete to authenticated
  using (private.can_write(household_id));

-- ── budget_month: budget vs actual for one month ──────────────────────────────
-- One row per main category that has a budget in force or spending that month. budget is null when
-- none is set; spent counts refunds against it (v_spend_by_category_month). Runs with the caller's
-- RLS, so another household's id returns nothing.
create function public.budget_month(p_household uuid, p_month date)
returns table (category_id uuid, name text, budget numeric, budget_from date, spent numeric, lines integer)
language sql
stable
set search_path = ''
as $$
  with m as (select date_trunc('month', p_month)::date as month),
  b as (
    select distinct on (x.category_id) x.category_id, x.amount, x.month
      from public.budget x, m
     where x.household_id = p_household and x.month <= m.month
     order by x.category_id, x.month desc
  ),
  s as (
    select v.top_category_id, sum(v.spent) as spent, sum(v.lines)::integer as lines
      from public.v_spend_by_category_month v, m
     where v.household_id = p_household and v.month = m.month and v.top_category_id is not null
     group by v.top_category_id
  )
  select c.id, c.name, nullif(b.amount, 0), case when b.amount > 0 then b.month end,
         coalesce(s.spent, 0), coalesce(s.lines, 0)
    from public.category c
    left join b on b.category_id = c.id
    left join s on s.top_category_id = c.id
   where c.household_id = p_household and c.parent_id is null
     and (b.amount > 0 or s.spent is not null)
   order by coalesce(s.spent, 0) desc, c.name
$$;

revoke execute on function public.budget_month(uuid, date) from public, anon;
grant execute on function public.budget_month(uuid, date) to authenticated;

update public.app_meta set value = '43' where key = 'schema_version';
