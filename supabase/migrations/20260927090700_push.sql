-- Phase 6 · 47 — Web Push subscriptions + the daily digest (MASTER_PLAN §4 row 7, §11.3)
-- Each browser that turns notifications on stores one push_subscription (its endpoint + keys).
-- Rows belong to the person who subscribed: you see and change only your own devices.
-- The daily job (migration 49) calls the attention-push Edge Function, which calls:
--   rpc_push_digest(token)          which households have subscribers + their top items (claims today's run)
--   rpc_push_result(token, run, …)  what happened per device; 404/410 endpoints are removed
-- Both are service_role only AND check a random token that this migration puts in Vault — the Edge
-- Function is reachable from the internet, so only the database's own job may start a run. Nobody
-- ever sees or types the token.

create table public.push_subscription (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint     text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh       text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),   -- base64url P-256 point
  auth         text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),      -- base64url 16-byte secret
  label        text check (length(label) <= 60),
  user_agent   text check (length(user_agent) <= 300),
  enabled      boolean not null default true,
  fail_count   integer not null default 0,
  last_ok_at   timestamptz,
  last_error   text check (length(last_error) <= 300),
  created_at   timestamptz not null default now(),
  foreign key (household_id, user_id) references public.household_member (household_id, user_id) on delete cascade
);

create index push_subscription_household_idx on public.push_subscription (household_id) where enabled;
create index push_subscription_user_idx on public.push_subscription (user_id);

create table public.push_run (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  run_on       date not null,
  items        integer not null default 0,
  sent         integer not null default 0,
  failed       integer not null default 0,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (household_id, run_on)
);

alter table public.push_subscription enable row level security;
alter table public.push_run enable row level security;

revoke all on table public.push_subscription, public.push_run from anon, authenticated;
grant select, delete on table public.push_subscription to authenticated;
grant update (label, enabled, last_ok_at, last_error, fail_count) on table public.push_subscription to authenticated;
grant select on table public.push_run to authenticated;

create policy push_subscription_select on public.push_subscription for select to authenticated
  using (user_id = (select auth.uid()) and private.is_member(household_id));
create policy push_subscription_update on public.push_subscription for update to authenticated
  using (user_id = (select auth.uid()) and private.is_member(household_id))
  with check (user_id = (select auth.uid()) and private.is_member(household_id));
create policy push_subscription_delete on public.push_subscription for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_member(household_id));
create policy push_run_select on public.push_run for select to authenticated
  using (private.is_member(household_id));

-- ── Subscribe (a shared iPad may move from one person to the other) ───────────
-- p: { household_id, endpoint, p256dh, auth, label?, user_agent? } → the row id
create function public.rpc_push_subscribe(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_id        uuid;
begin
  if (select auth.uid()) is null or v_household is null or not private.is_member(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.push_subscription s where s.endpoint = p ->> 'endpoint';
  insert into public.push_subscription (household_id, user_id, endpoint, p256dh, auth, label, user_agent)
  values (v_household, (select auth.uid()), p ->> 'endpoint', p ->> 'p256dh', p ->> 'auth',
          nullif(btrim(p ->> 'label'), ''), left(p ->> 'user_agent', 300))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.rpc_push_subscribe(jsonb) from public, anon;
grant execute on function public.rpc_push_subscribe(jsonb) to authenticated;

-- ── The cron token (random, lives only in Vault) ──────────────────────────────
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'gedara_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'gedara_cron_token',
                                'Gedara: authorises the daily attention-push run (migration 47)');
  end if;
end;
$$;

create function private.cron_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gedara_cron_token'
$$;

create function private.check_cron_token(p_token text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_token is null or p_token is distinct from private.cron_token() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function private.cron_token() from public, anon, authenticated;
revoke execute on function private.check_cron_token(text) from public, anon, authenticated;

-- ── rpc_push_digest ───────────────────────────────────────────────────────────
-- For every household with enabled devices whose run for today (household date) hasn't happened:
-- claims the run and returns { runs: [{ run_id, household_id, total, items: [top 5], subscriptions: [...] }] }.
-- A household with nothing to say gets its run recorded (items 0) and no subscriptions returned.
create function public.rpc_push_digest(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h      record;
  v_today  date;
  v_run    uuid;
  v_total  integer;
  v_items  jsonb;
  v_subs   jsonb;
  v_runs   jsonb := '[]'::jsonb;
begin
  perform private.check_cron_token(p_token);
  for v_h in
    select distinct s.household_id from public.push_subscription s where s.enabled
  loop
    v_today := private.household_today(v_h.household_id);
    insert into public.push_run (household_id, run_on) values (v_h.household_id, v_today)
    on conflict (household_id, run_on) do nothing
    returning id into v_run;
    continue when v_run is null;  -- already ran today

    select count(*)::integer,
           coalesce(jsonb_agg(to_jsonb(i) - 'extra' - 'unit') filter (where i.rn <= 5), '[]'::jsonb)
      into v_total, v_items
      from (select a.*, row_number() over () as rn from private.attention_visible(v_h.household_id) a) i;
    update public.push_run r set items = v_total where r.id = v_run;
    if v_total = 0 then
      update public.push_run r set finished_at = now() where r.id = v_run;
      continue;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
      into v_subs
      from public.push_subscription s where s.household_id = v_h.household_id and s.enabled;

    v_runs := v_runs || jsonb_build_object('run_id', v_run, 'household_id', v_h.household_id, 'total', v_total,
                                           'items', v_items, 'subscriptions', v_subs);
  end loop;
  return jsonb_build_object('runs', v_runs);
end;
$$;

-- ── rpc_push_result ───────────────────────────────────────────────────────────
-- p_results: [{ id, ok: bool, status?: int, error?: text }]
create function public.rpc_push_result(p_token text, p_run uuid, p_results jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r jsonb;
begin
  perform private.check_cron_token(p_token);
  for v_r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if (v_r ->> 'ok')::boolean then
      update public.push_subscription s set last_ok_at = now(), fail_count = 0, last_error = null
       where s.id = (v_r ->> 'id')::uuid;
    elsif (v_r ->> 'status')::integer in (404, 410) then
      delete from public.push_subscription s where s.id = (v_r ->> 'id')::uuid;   -- the browser dropped it
    else
      update public.push_subscription s
         set fail_count = s.fail_count + 1, last_error = left(coalesce(v_r ->> 'error', 'failed'), 300)
       where s.id = (v_r ->> 'id')::uuid;
    end if;
  end loop;
  update public.push_run r
     set sent = (select count(*) from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x where (x ->> 'ok')::boolean),
         failed = (select count(*) from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x where not (x ->> 'ok')::boolean),
         finished_at = now()
   where r.id = p_run;
end;
$$;

revoke execute on function public.rpc_push_digest(text) from public, anon, authenticated;
revoke execute on function public.rpc_push_result(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_push_digest(text) to service_role;
grant execute on function public.rpc_push_result(text, uuid, jsonb) to service_role;

update public.app_meta set value = '47' where key = 'schema_version';
