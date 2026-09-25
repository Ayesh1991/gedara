-- Phase 6 · 41 — recurring bills (MASTER_PLAN §3.6 recurring_rule + meter_reading, §4 rows 7 and 9)
-- CEB electricity, NWSDB water, SLT / Dialog, LP gas, insurance, salary … A rule never posts on its
-- own (money entries are confirmed by a person, decisions 2026-09-24): "Pay" saves the expense and
-- links it, or an SMS / scanned bill already in Money is linked to the rule.
--
-- Due dates are computed, never stored:
--   period k   = first_due + k × every_n every_unit   (months/years from first_due, so no drift)
--   next due   = the first period after the latest paid or skipped period, else first_due
-- A payment is a money_transaction with recurring_id + recurring_period (one per period), so
-- deleting it makes the bill due again by itself.

create table public.recurring_rule (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.household (id) on delete cascade,
  name               text not null check (length(btrim(name)) between 1 and 80),
  type               text not null default 'expense' check (type in ('expense', 'income')),
  account_id         uuid,
  category_id        uuid,
  payee_text         text check (length(payee_text) <= 120),
  expected_amount    numeric(14,2) check (expected_amount >= 0),
  every_n            integer not null default 1 check (every_n between 1 and 366),
  every_unit         text not null default 'month' check (every_unit in ('day', 'week', 'month', 'year')),
  first_due          date not null,
  notify_days_before integer not null default 3 check (notify_days_before between 0 and 60),
  usage_unit         text check (usage_unit in ('kWh', 'm³', 'kg', 'L')),   -- units typed when paying
  asset_id           uuid,                                                   -- insurance policy → the thing
  active             boolean not null default true,
  notes              text check (length(notes) <= 1000),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, account_id) references public.account (household_id, id)
    on delete set null (account_id),
  foreign key (household_id, category_id) references public.category (household_id, id)
    on delete set null (category_id),
  foreign key (household_id, asset_id) references public.asset (household_id, id)
    on delete set null (asset_id)
);

create unique index recurring_rule_name_idx on public.recurring_rule (household_id, lower(btrim(name)));
create index recurring_rule_account_idx on public.recurring_rule (household_id, account_id) where account_id is not null;
create index recurring_rule_category_idx on public.recurring_rule (household_id, category_id) where category_id is not null;
create index recurring_rule_asset_idx on public.recurring_rule (household_id, asset_id) where asset_id is not null;
create index recurring_rule_created_by_idx on public.recurring_rule (created_by);

create function private.recurring_rule_normalise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.payee_text := nullif(btrim(new.payee_text), '');
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;

create trigger recurring_rule_normalise
  before insert or update on public.recurring_rule
  for each row execute function private.recurring_rule_normalise();

create trigger recurring_rule_updated_at
  before update on public.recurring_rule
  for each row execute function private.set_updated_at();

-- "Not this time": a skipped period counts as settled.
create table public.recurring_skip (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  rule_id      uuid not null,
  period       date not null,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (rule_id, period),
  foreign key (household_id, rule_id) references public.recurring_rule (household_id, id) on delete cascade
);

create index recurring_skip_rule_idx on public.recurring_skip (household_id, rule_id, period desc);
create index recurring_skip_created_by_idx on public.recurring_skip (created_by);

-- Payments: the transaction says which rule and which period it paid. Written by the RPCs of
-- migration 42 only (money_transaction stays read-only to clients).
alter table public.money_transaction
  add column recurring_id uuid,
  add column recurring_period date,
  add constraint money_transaction_recurring_fkey foreign key (household_id, recurring_id)
    references public.recurring_rule (household_id, id) on delete set null (recurring_id);

create unique index money_transaction_recurring_idx on public.money_transaction (household_id, recurring_id, recurring_period)
  where recurring_id is not null;

-- kWh / m³ on a utility bill (§4 row 9). Goes with its payment.
create table public.meter_reading (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  recurring_id   uuid not null,
  transaction_id uuid,
  read_on        date not null,
  units          numeric(14,4) not null check (units > 0),     -- used in the billing period
  meter_value    numeric(14,4) check (meter_value >= 0),       -- the meter itself, when written down
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (transaction_id),
  foreign key (household_id, recurring_id) references public.recurring_rule (household_id, id) on delete cascade,
  foreign key (household_id, transaction_id) references public.money_transaction (household_id, id) on delete cascade
);

create index meter_reading_rule_idx on public.meter_reading (household_id, recurring_id, read_on desc);
create index meter_reading_created_by_idx on public.meter_reading (created_by);

-- ── Period arithmetic ─────────────────────────────────────────────────────────
create function private.recurring_period(p_first date, p_n integer, p_unit text, p_k integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_unit
           when 'day' then p_first + p_k * p_n
           when 'week' then p_first + p_k * p_n * 7
           when 'month' then (p_first + make_interval(months => p_k * p_n))::date
           when 'year' then (p_first + make_interval(years => p_k * p_n))::date
         end
$$;

-- The first period strictly after p_after (first_due when nothing is settled yet).
create function private.recurring_next(p_first date, p_n integer, p_unit text, p_after date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_k integer;
begin
  if p_after is null or p_after < p_first then
    return p_first;
  end if;
  v_k := case p_unit
           when 'day' then (p_after - p_first) / p_n
           when 'week' then (p_after - p_first) / (7 * p_n)
           when 'month' then ((extract(year from age(p_after, p_first)) * 12 + extract(month from age(p_after, p_first)))::integer) / p_n
           else (extract(year from age(p_after, p_first))::integer) / p_n
         end;
  v_k := greatest(v_k - 1, 0);
  while private.recurring_period(p_first, p_n, p_unit, v_k) <= p_after loop
    v_k := v_k + 1;
  end loop;
  return private.recurring_period(p_first, p_n, p_unit, v_k);
end;
$$;

revoke execute on function private.recurring_period(date, integer, text, integer) from public, anon;
revoke execute on function private.recurring_next(date, integer, text, date) from public, anon;
grant execute on function private.recurring_period(date, integer, text, integer) to authenticated;
grant execute on function private.recurring_next(date, integer, text, date) to authenticated;

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.recurring_rule enable row level security;
alter table public.recurring_skip enable row level security;
alter table public.meter_reading enable row level security;

revoke all on table public.recurring_rule, public.recurring_skip, public.meter_reading from anon, authenticated;

grant select, delete on table public.recurring_rule to authenticated;
grant insert (id, household_id, name, type, account_id, category_id, payee_text, expected_amount, every_n, every_unit,
              first_due, notify_days_before, usage_unit, asset_id, active, notes)
  on table public.recurring_rule to authenticated;
grant update (name, type, account_id, category_id, payee_text, expected_amount, every_n, every_unit, first_due,
              notify_days_before, usage_unit, asset_id, active, notes)
  on table public.recurring_rule to authenticated;

grant select, delete on table public.recurring_skip to authenticated;
grant insert (id, household_id, rule_id, period) on table public.recurring_skip to authenticated;

grant select, delete on table public.meter_reading to authenticated;
grant update (units, meter_value, read_on) on table public.meter_reading to authenticated;

create policy recurring_rule_select on public.recurring_rule for select to authenticated
  using (private.is_member(household_id));
create policy recurring_rule_insert on public.recurring_rule for insert to authenticated
  with check (private.can_write(household_id));
create policy recurring_rule_update on public.recurring_rule for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy recurring_rule_delete on public.recurring_rule for delete to authenticated
  using (private.can_write(household_id));

create policy recurring_skip_select on public.recurring_skip for select to authenticated
  using (private.is_member(household_id));
create policy recurring_skip_insert on public.recurring_skip for insert to authenticated
  with check (private.can_write(household_id));
create policy recurring_skip_delete on public.recurring_skip for delete to authenticated
  using (private.can_write(household_id));

create policy meter_reading_select on public.meter_reading for select to authenticated
  using (private.is_member(household_id));
create policy meter_reading_update on public.meter_reading for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy meter_reading_delete on public.meter_reading for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '41' where key = 'schema_version';
