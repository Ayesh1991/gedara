-- Phase 5 · 35 — maintenance plans + logs (MASTER_PLAN §3.5, §4 row 5)
-- A plan is a recurring job on an asset ("AC service every 180 days", "UPS battery every 2 years",
-- "car service every 5000 km"). A log is one job done. A log with a cost is written only by
-- rpc_log_maintenance (migration 37), which also creates or links the ledger expense, so the cost
-- is in the ledger exactly once. Plan due dates follow the logs: next due = last done + every_days.

create table public.maintenance_plan (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.household (id) on delete cascade,
  asset_id           uuid not null,
  name               text not null check (length(btrim(name)) between 1 and 80),
  category_id        uuid,                                    -- the expense category for its costs
  every_days         integer check (every_days between 1 and 3650),
  every_usage        numeric(14,4) check (every_usage > 0),  -- e.g. every 5000 (km)
  usage_unit         text check (length(usage_unit) <= 12),
  next_due           date,
  notify_days_before integer not null default 7 check (notify_days_before between 0 and 365),
  active             boolean not null default true,
  notes              text check (length(notes) <= 1000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete cascade,
  foreign key (household_id, category_id) references public.category (household_id, id)
    on delete set null (category_id)
);

create index maintenance_plan_asset_idx on public.maintenance_plan (household_id, asset_id);
create index maintenance_plan_category_idx on public.maintenance_plan (household_id, category_id) where category_id is not null;
create index maintenance_plan_due_idx on public.maintenance_plan (household_id, next_due) where active;

create table public.maintenance_log (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.household (id) on delete cascade,
  asset_id        uuid not null,
  plan_id         uuid,
  done_on         date not null default current_date,
  title           text not null check (length(btrim(title)) between 1 and 120),
  notes           text check (length(notes) <= 2000),
  cost            numeric(14,2) check (cost >= 0),
  vendor          text check (length(vendor) <= 120),
  transaction_id  uuid,                                       -- the ledger expense for `cost`
  created_expense boolean not null default false,             -- that expense was made by this log
  usage_reading   numeric(14,4) check (usage_reading >= 0),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete cascade,
  foreign key (household_id, plan_id) references public.maintenance_plan (household_id, id)
    on delete set null (plan_id),
  -- Deleting the expense in Money keeps the log and its cost; only the link goes.
  foreign key (household_id, transaction_id) references public.money_transaction (household_id, id)
    on delete set null (transaction_id)
);

create index maintenance_log_asset_idx on public.maintenance_log (household_id, asset_id, done_on desc);
create index maintenance_log_plan_idx on public.maintenance_log (household_id, plan_id) where plan_id is not null;
create index maintenance_log_tx_idx on public.maintenance_log (household_id, transaction_id) where transaction_id is not null;
create index maintenance_log_created_by_idx on public.maintenance_log (created_by);

-- ── Triggers ──────────────────────────────────────────────────────────────────

create function private.maintenance_plan_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last date;
begin
  new.name := btrim(new.name);
  new.usage_unit := nullif(btrim(new.usage_unit), '');
  new.notes := nullif(btrim(new.notes), '');
  -- A changed interval moves the due date from the last time it was done.
  if tg_op = 'UPDATE' and new.every_days is distinct from old.every_days and new.every_days is not null then
    select max(g.done_on) into v_last from public.maintenance_log g where g.plan_id = new.id;
    if v_last is not null then
      new.next_due := v_last + new.every_days;
    end if;
  end if;
  return new;
end;
$$;

create trigger maintenance_plan_tidy
  before insert or update on public.maintenance_plan
  for each row execute function private.maintenance_plan_tidy();

create trigger maintenance_plan_updated_at
  before update on public.maintenance_plan
  for each row execute function private.set_updated_at();

-- A log's plan must be a plan of the same asset.
create function private.maintenance_log_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.notes := nullif(btrim(new.notes), '');
  new.vendor := nullif(btrim(new.vendor), '');
  if new.plan_id is not null and not exists (
    select 1 from public.maintenance_plan m
     where m.id = new.plan_id and m.household_id = new.household_id and m.asset_id = new.asset_id
  ) then
    raise exception 'that plan belongs to another thing' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger maintenance_log_check
  before insert or update on public.maintenance_log
  for each row execute function private.maintenance_log_check();

create trigger maintenance_log_updated_at
  before update on public.maintenance_log
  for each row execute function private.set_updated_at();

-- next_due of the plan(s) a log belongs / belonged to = last done + every_days. When the last log of
-- a plan is removed the due date stays as it was. SECURITY DEFINER: clients may not write next_due
-- through a log, and a viewer's RLS mustn't hide logs from the recount.
create function private.maintenance_plan_refresh(p_plan uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.maintenance_plan m
     set next_due = s.last_done + m.every_days
    from (select max(g.done_on) as last_done from public.maintenance_log g where g.plan_id = p_plan) s
   where m.id = p_plan and m.every_days is not null and s.last_done is not null
     and m.next_due is distinct from s.last_done + m.every_days;
end;
$$;

revoke execute on function private.maintenance_plan_refresh(uuid) from public, anon, authenticated;

create function private.maintenance_log_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.plan_id is not null then
    perform private.maintenance_plan_refresh(new.plan_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.plan_id is not null
     and (tg_op = 'DELETE' or old.plan_id is distinct from new.plan_id) then
    perform private.maintenance_plan_refresh(old.plan_id);
  end if;
  return null;
end;
$$;

create trigger maintenance_log_after
  after insert or update of plan_id, done_on or delete on public.maintenance_log
  for each row execute function private.maintenance_log_after();

-- A log's photos / receipts go when it goes (the client removes the files, best effort).
create function private.maintenance_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'maintenance' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger maintenance_delete_attachments
  after delete on public.maintenance_log
  for each row execute function private.maintenance_delete_attachments();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.maintenance_plan enable row level security;
alter table public.maintenance_log enable row level security;

revoke all on table public.maintenance_plan from anon, authenticated;
revoke all on table public.maintenance_log from anon, authenticated;

grant select, delete on table public.maintenance_plan to authenticated;
grant insert (id, household_id, asset_id, name, category_id, every_days, every_usage, usage_unit, next_due,
              notify_days_before, active, notes)
  on table public.maintenance_plan to authenticated;
grant update (name, category_id, every_days, every_usage, usage_unit, next_due, notify_days_before, active, notes)
  on table public.maintenance_plan to authenticated;

-- Logs are created by rpc_log_maintenance only (cost ↔ ledger); the words and date stay editable.
grant select, delete on table public.maintenance_log to authenticated;
grant update (title, notes, vendor, done_on, usage_reading) on table public.maintenance_log to authenticated;

create policy maintenance_plan_select on public.maintenance_plan for select to authenticated
  using (private.is_member(household_id));
create policy maintenance_plan_insert on public.maintenance_plan for insert to authenticated
  with check (private.can_write(household_id));
create policy maintenance_plan_update on public.maintenance_plan for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy maintenance_plan_delete on public.maintenance_plan for delete to authenticated
  using (private.can_write(household_id));

create policy maintenance_log_select on public.maintenance_log for select to authenticated
  using (private.is_member(household_id));
create policy maintenance_log_update on public.maintenance_log for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy maintenance_log_delete on public.maintenance_log for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '35' where key = 'schema_version';
