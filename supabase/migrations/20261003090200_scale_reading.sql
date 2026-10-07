-- Phase 6b · 64 — what the scale saw, and commands for it
-- scale_reading: one row per stable weighing (from a scale, or typed in the app). It is the audit
-- trail of the scale and the idempotency record: a device reading is unique by (device, epoch, seq),
-- an app reading by (household, op_id); a replay returns the stored `result` and moves nothing.
-- Stock itself still changes only through stock_movement rows (rule 1); `correlation_id` links them.
-- device_command: tare / calibrate / beep / identify / reboot / ota, picked up by the device on its
-- next sync. Both tables are read-only to clients and live over Realtime (the iPad's live card).

create table public.scale_reading (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  device_id      uuid,
  epoch          bigint check (epoch between 0 and 4294967295),
  seq            bigint check (seq between 0 and 4294967295),
  op_id          uuid,
  at             timestamptz not null,                   -- when it was weighed
  received_at    timestamptz not null default now(),
  time_estimated boolean not null default false,          -- the device had no clock: `at` is estimated
  uid            text check (length(uid) <= 20),
  location_id    uuid,
  product_id     uuid,
  gross_g        numeric(14,4),
  tare_g         numeric(14,4),
  net_g          numeric(14,4),
  stock_before_g numeric(14,4),                           -- the jar's stock, in grams, before this reading
  delta_g        numeric(14,4),                           -- net − stock before
  moved_g        numeric(14,4),                           -- what was recorded: − used, + moved in
  pending_g      numeric(14,4),                           -- heavier than stock and nothing to move it from
  status         text not null check (status in (
                   'consumed', 'no_change', 'refilled', 'needs_decision', 'decided', 'below_tare', 'superseded',
                   'unknown_tag', 'no_tag', 'no_product', 'no_tare', 'tare_set', 'error')),
  correlation_id uuid,
  decision       jsonb check (decision is null or jsonb_typeof(decision) = 'object'),
  decided_by     uuid references auth.users (id) on delete set null,
  decided_at     timestamptz,
  error_code     text check (length(error_code) <= 10),
  result         jsonb not null check (jsonb_typeof(result) = 'object'),
  actor          uuid default auth.uid() references auth.users (id) on delete set null,
  unique (household_id, id),
  unique (device_id, epoch, seq),
  unique (household_id, op_id),
  check ((device_id is not null and epoch is not null and seq is not null) or op_id is not null),
  foreign key (household_id, device_id) references public.device (household_id, id)
    on delete set null (device_id),
  foreign key (household_id, location_id) references public.location (household_id, id)
    on delete set null (location_id),
  foreign key (household_id, product_id) references public.product (household_id, id)
    on delete set null (product_id)
);

create index scale_reading_household_idx on public.scale_reading (household_id, received_at desc);
create index scale_reading_device_idx on public.scale_reading (device_id, received_at desc);
create index scale_reading_location_idx on public.scale_reading (household_id, location_id, at desc)
  where location_id is not null;
create index scale_reading_open_idx on public.scale_reading (household_id, status)
  where status in ('needs_decision', 'unknown_tag');
create index scale_reading_correlation_idx on public.scale_reading (household_id, correlation_id)
  where correlation_id is not null;
create index scale_reading_product_idx on public.scale_reading (household_id, product_id) where product_id is not null;
create index scale_reading_decided_by_idx on public.scale_reading (decided_by);
create index scale_reading_actor_idx on public.scale_reading (actor);

create table public.device_command (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  command      text not null check (command in ('tare', 'calibrate', 'beep', 'identify', 'reboot', 'ota')),
  args         jsonb not null default '{}' check (jsonb_typeof(args) = 'object'),
  status       text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'expired')),
  result       jsonb check (result is null or jsonb_typeof(result) = 'object'),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz,
  unique (household_id, id),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade
);

create index device_command_device_idx on public.device_command (device_id, created_at desc);
create index device_command_open_idx on public.device_command (device_id) where status in ('queued', 'sent');
create index device_command_household_idx on public.device_command (household_id);
create index device_command_created_by_idx on public.device_command (created_by);

alter table public.scale_reading enable row level security;
alter table public.device_command enable row level security;

revoke all on table public.scale_reading from anon, authenticated;
revoke all on table public.device_command from anon, authenticated;
grant select on table public.scale_reading to authenticated;
grant select on table public.device_command to authenticated;

create policy scale_reading_select on public.scale_reading
  for select to authenticated
  using (private.is_member(household_id));

create policy device_command_select on public.device_command
  for select to authenticated
  using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.scale_reading;
    alter publication supabase_realtime add table public.device_command;
  end if;
end;
$$;

update public.app_meta set value = '64' where key = 'schema_version';
