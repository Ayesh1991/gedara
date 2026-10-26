-- Phase 9 · 94 — Instalment plans (9b.2): card instalment plans and loans, one snapshot page.
--
-- A plan is a fixed monthly amount on an account (a credit card's instalment plan, or a loan's monthly
-- instalment) for a known number of months. Everything shown — which instalment is due now, the last
-- date, what is left, a loan's interest / principal split — is worked out from these few facts in the
-- app (apps/web/src/lib/money/instalments.ts), so nothing here has to be updated month by month.
-- Plans are reference data: they never move money (the bank's own entries and Gedara's transfers do).

create table public.instalment_plan (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  account_id     uuid not null,
  kind           text not null check (kind in ('card', 'loan')),
  name           text not null check (length(btrim(name)) between 1 and 80),
  monthly        numeric(14,2) not null check (monthly > 0),
  total_count    integer not null check (total_count between 1 and 600),
  -- the date the first instalment was charged / paid (later ones fall on the same day of each month)
  first_on       date not null,
  -- loans: the amount borrowed and the yearly interest rate (percent), for the interest / principal split
  principal      numeric(14,2) check (principal is null or principal > 0),
  annual_rate    numeric(6,3) check (annual_rate is null or (annual_rate >= 0 and annual_rate < 100)),
  -- the SMS that announced the plan (People's "12-months instalment plan … created"), if any
  source_sms_id  uuid,
  notes          text check (notes is null or length(notes) <= 500),
  archived       boolean not null default false,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, account_id) references public.account (household_id, id) on delete cascade,
  foreign key (household_id, source_sms_id) references public.sms_message (household_id, id) on delete set null (source_sms_id),
  check (kind = 'card' or (principal is not null and annual_rate is not null))
);

create index instalment_plan_household_idx on public.instalment_plan (household_id) where not archived;

create trigger instalment_plan_touch
  before update on public.instalment_plan
  for each row execute function private.set_updated_at();

alter table public.instalment_plan enable row level security;
revoke all on table public.instalment_plan from anon, authenticated;
grant select, delete on table public.instalment_plan to authenticated;
grant insert (id, household_id, account_id, kind, name, monthly, total_count, first_on, principal, annual_rate, source_sms_id, notes)
  on table public.instalment_plan to authenticated;
grant update (account_id, kind, name, monthly, total_count, first_on, principal, annual_rate, notes, archived)
  on table public.instalment_plan to authenticated;

create policy instalment_plan_select on public.instalment_plan for select to authenticated
  using (private.is_member(household_id));
create policy instalment_plan_insert on public.instalment_plan for insert to authenticated
  with check (private.can_write(household_id));
create policy instalment_plan_update on public.instalment_plan for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy instalment_plan_delete on public.instalment_plan for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '94' where key = 'schema_version';
