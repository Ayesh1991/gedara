-- Phase 7b · 58 — put things and places into places by scanning, online or offline
-- "Scan a thing → scan a box" and "Fill this box" move a thing (asset.location_id) or a place
-- (location.parent_id). Like stock actions (migration 50), every move carries an op id made on the
-- phone when it was tapped, so a queued move that is replayed after the phone comes back online, a
-- double tap or a retry never moves twice. Products keep moving through rpc_stock_op('transfer').
--
-- Newest wins, but nothing changes silently: an offline move whose item was moved again (on any
-- device, by any path) after the tap is refused with GDMVC and parked by the app ("Couldn't sync":
-- Move anyway / Discard). `moved_at` records when an item last changed place; for a replayed move
-- it is the tap time, so two queued moves of the same item replay in order.
--
-- Error codes the app maps to messages:
--   GDMVC  detail 'newer' (moved again after this tap) · 'moved' (not where Undo expected it)

alter table public.asset add column moved_at timestamptz;
alter table public.location add column moved_at timestamptz;

create function private.stamp_moved_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- rpc_move passes the tap time of an offline move; every other path moves "now".
  new.moved_at := coalesce(nullif(current_setting('gedara.move_at', true), '')::timestamptz, now());
  return new;
end;
$$;

create trigger asset_moved_at
  before update of location_id on public.asset
  for each row when (old.location_id is distinct from new.location_id)
  execute function private.stamp_moved_at();

create trigger location_moved_at
  before update of parent_id on public.location
  for each row when (old.parent_id is distinct from new.parent_id)
  execute function private.stamp_moved_at();

revoke execute on function private.stamp_moved_at() from public, anon, authenticated;

create table public.move_op (
  household_id uuid not null references public.household (id) on delete cascade,
  op_id        uuid not null,
  kind         text not null check (kind in ('asset', 'location')),
  item_id      uuid not null,
  from_id      uuid,
  to_id        uuid,
  result       jsonb not null check (jsonb_typeof(result) = 'object'),
  client_at    timestamptz,
  actor        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (household_id, op_id)
);

create index move_op_op_idx on public.move_op (op_id);
create index move_op_actor_idx on public.move_op (actor);

alter table public.move_op enable row level security;

revoke all on table public.move_op from anon, authenticated;
grant select on table public.move_op to authenticated;

create policy move_op_select on public.move_op
  for select to authenticated
  using (private.is_member(household_id));

-- p_kind 'asset' | 'location'; p_to null = no place (thing) / top level (place).
-- p_client_at: tap time of a queued move (null = now). p_force: "Move anyway" after a GDMVC.
-- p_expect {"from": uuid|null}: Undo only moves the item back if it is still where the move put it.
create function public.rpc_move(
  p_op_id uuid, p_kind text, p_id uuid, p_to uuid,
  p_client_at timestamptz default null, p_force boolean default false, p_expect jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_from      uuid;
  v_moved_at  timestamptz;
  v_done      jsonb;
  v_at        timestamptz := least(coalesce(p_client_at, now()), now());
  v_result    jsonb;
begin
  if p_op_id is null then
    raise exception 'op_id is required' using errcode = '23514';
  end if;

  -- Two replays of the same op at the same moment: the second waits here, then finds the first.
  perform pg_advisory_xact_lock(hashtextextended('move:' || p_op_id::text, 0));
  select o.result into v_done
    from public.move_op o
   where o.op_id = p_op_id and private.is_member(o.household_id);
  if found then
    return v_done || jsonb_build_object('replayed', true);
  end if;

  if p_kind = 'asset' then
    select a.household_id, a.location_id, a.moved_at into v_household, v_from, v_moved_at
      from public.asset a where a.id = p_id for update;
  elsif p_kind = 'location' then
    select l.household_id, l.parent_id, l.moved_at into v_household, v_from, v_moved_at
      from public.location l where l.id = p_id for update;
  else
    raise exception 'unknown kind' using errcode = '23514';
  end if;
  if v_household is null or not private.is_member(v_household) then
    raise exception 'unknown item' using errcode = '23503';
  end if;
  if not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to is not null and not exists (
    select 1 from public.location l where l.id = p_to and l.household_id = v_household
  ) then
    raise exception 'unknown place' using errcode = '23503';
  end if;

  if p_expect ? 'from' and v_from is distinct from (p_expect ->> 'from')::uuid then
    raise exception 'it was moved since' using errcode = 'GDMVC', detail = 'moved';
  end if;
  if p_client_at is not null and not coalesce(p_force, false) and v_moved_at > p_client_at then
    raise exception 'it was moved again after this' using errcode = 'GDMVC', detail = 'newer';
  end if;

  perform set_config('gedara.move_at', v_at::text, true);
  if p_kind = 'asset' then
    update public.asset a set location_id = p_to where a.id = p_id;
  else
    -- The path trigger refuses a place inside itself or its own children (23514).
    update public.location l set parent_id = p_to where l.id = p_id;
  end if;
  perform set_config('gedara.move_at', '', true);

  v_result := jsonb_build_object('op_id', p_op_id, 'kind', p_kind, 'id', p_id, 'from', v_from, 'to', p_to);
  insert into public.move_op (household_id, op_id, kind, item_id, from_id, to_id, result, client_at)
  values (v_household, p_op_id, p_kind, p_id, v_from, p_to, v_result,
          case when p_client_at is not null then v_at end);
  return v_result;
end;
$$;

revoke execute on function public.rpc_move(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) from public, anon;
grant execute on function public.rpc_move(uuid, text, uuid, uuid, timestamptz, boolean, jsonb) to authenticated;

update public.app_meta set value = '58' where key = 'schema_version';
