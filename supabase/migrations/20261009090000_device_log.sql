-- Phase 6b · 68 — the scale's log in Gedara
-- Once the scale is built, its USB port is sealed inside: the Serial Monitor is gone. The scale now
-- sends its recent log lines ("[SCALE] steady: 1000.2 g", "[NET] Wi-Fi lost …") with each sync and
-- they are kept here, shown live on the scale's page (Settings › Devices). Written only by
-- rpc_scale_log (service role, after the Edge Function checked the scale's key); the last 7 days and
-- at most 1,000 lines per scale are kept.

create table public.device_log (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  device_id    uuid not null,
  at           timestamptz not null default now(),   -- when the scale wrote it (estimated from its uptime)
  boot         bigint check (boot between 0 and 4294967295),
  line         text not null check (length(line) between 1 and 160),
  foreign key (household_id, device_id) references public.device (household_id, id) on delete cascade
);

create index device_log_device_idx on public.device_log (device_id, id desc);
create index device_log_household_idx on public.device_log (household_id);

alter table public.device_log enable row level security;
revoke all on table public.device_log from anon, authenticated;
grant select on table public.device_log to authenticated;

create policy device_log_select on public.device_log
  for select to authenticated
  using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.device_log;
  end if;
end;
$$;

-- p_lines: [{t: uptime ms when written, m: text}], at most 30; p_up / p_boot: the scale's uptime and
-- boot counter now (to turn uptimes into times). Returns how many lines were stored.
create function public.rpc_scale_log(p_token_hash text, p_boot bigint, p_up bigint, p_lines jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
  v_n   integer;
begin
  select d.* into v_dev from public.device_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null;
  if not found then
    raise exception 'unknown or revoked device' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 30 then
    raise exception 'at most 30 lines' using errcode = '23514';
  end if;

  insert into public.device_log (household_id, device_id, at, boot, line)
  select v_dev.household_id, v_dev.id,
         case when (x ->> 't')::bigint between 0 and p_up
              then now() - make_interval(secs => (p_up - (x ->> 't')::bigint) / 1000.0)
              else now() end,
         p_boot,
         left(nullif(btrim(x ->> 'm'), ''), 160)
    from jsonb_array_elements(p_lines) x
   where nullif(btrim(x ->> 'm'), '') is not null;
  get diagnostics v_n = row_count;

  -- Keep it small: 7 days, and the newest 1,000 lines per scale.
  delete from public.device_log l
   where l.device_id = v_dev.id
     and (l.at < now() - interval '7 days'
          or l.id < (select l2.id from public.device_log l2 where l2.device_id = v_dev.id
                      order by l2.id desc offset 999 limit 1));
  return v_n;
end;
$$;

revoke execute on function public.rpc_scale_log(text, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_scale_log(text, bigint, bigint, jsonb) to service_role;

update public.app_meta set value = '68' where key = 'schema_version';
