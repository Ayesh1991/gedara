-- Phase 7 · 50 — idempotent stock actions (offline outbox, MASTER_PLAN §9 Phase 7)
-- A phone that was offline replays its queued "use 1 / open / move" when it reconnects. A replay
-- (or a double tap, or a retry after a timeout) must never take the stock twice, so every action
-- from the app now carries an `op_id` chosen on the device when the button was tapped, and goes
-- through rpc_stock_op:
--   · the op id is seen for the first time → run the existing RPC (rpc_consume / rpc_open /
--     rpc_transfer of migration 26, unchanged) and remember its result;
--   · the op id was already done → return the remembered result with `replayed: true`.
-- An error rolls the whole call back (no op row), so a refused op can be retried or parked by the
-- app. Undo stays rpc_undo(correlation_id); the correlation comes back in the result.

create table public.stock_op (
  household_id   uuid not null references public.household (id) on delete cascade,
  op_id          uuid not null,
  action         text not null check (action in ('consume', 'open', 'transfer')),
  correlation_id uuid not null,
  result         jsonb not null check (jsonb_typeof(result) = 'object'),
  client_at      timestamptz,                             -- when it was tapped (offline ops)
  actor          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  primary key (household_id, op_id)
);

create index stock_op_correlation_idx on public.stock_op (household_id, correlation_id);
create index stock_op_actor_idx on public.stock_op (actor);

alter table public.stock_op enable row level security;

revoke all on table public.stock_op from anon, authenticated;
grant select on table public.stock_op to authenticated;

create policy stock_op_select on public.stock_op
  for select to authenticated
  using (private.is_member(household_id));

-- p_action: consume (also waste, via p.reason) · open · transfer; p: exactly what the wrapped RPC takes.
create function public.rpc_stock_op(p_op_id uuid, p_action text, p jsonb, p_client_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_done      jsonb;
  v_result    jsonb;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_op_id is null then
    raise exception 'op_id is required' using errcode = '23514';
  end if;
  if p_action is null or p_action not in ('consume', 'open', 'transfer') then
    raise exception 'unknown action' using errcode = '23514';
  end if;

  -- Two replays of the same op at the same moment: the second waits here, then finds the first.
  perform pg_advisory_xact_lock(hashtextextended(v_household::text || ':' || p_op_id::text, 0));

  select o.result into v_done
    from public.stock_op o
   where o.household_id = v_household and o.op_id = p_op_id;
  if found then
    return v_done || jsonb_build_object('replayed', true);
  end if;

  v_result := case p_action
                when 'consume' then public.rpc_consume(p)
                when 'open' then public.rpc_open(p)
                else public.rpc_transfer(p)
              end;

  insert into public.stock_op (household_id, op_id, action, correlation_id, result, client_at)
  values (v_household, p_op_id, p_action, (v_result ->> 'correlation_id')::uuid, v_result,
          least(p_client_at, now()));

  return v_result;
end;
$$;

revoke execute on function public.rpc_stock_op(uuid, text, jsonb, timestamptz) from public, anon;
grant execute on function public.rpc_stock_op(uuid, text, jsonb, timestamptz) to authenticated;

update public.app_meta set value = '50' where key = 'schema_version';
