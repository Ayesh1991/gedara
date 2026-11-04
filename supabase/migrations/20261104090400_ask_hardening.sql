-- Phase 10 · 102 — hardening after the security review of 98–101
--
-- 1. Ask usage can't be under-reported. rpc_ask_begin now issues a one-time secret (only its sha256 is
--    stored) that it returns to the caller — the ask-gedara function, never the browser — and rpc_ask_record
--    needs it. A member who calls rpc_ask_record directly with their own request id no longer can write the
--    function's cost as 0. (The function also withholds the plan when recording fails.)
-- 2. Valuable places: every SECURITY DEFINER path, not only rpc_move. The stock RPCs (purchase, consume,
--    transfer, inventory, weigh, undo …), the things RPCs and the place RPCs bypass RLS, so one guard per
--    table refuses any write by someone other than the owner that touches a hidden place: a stock lot or
--    movement there, a thing kept there, the place itself or a new place inside it. Only direct writes are
--    checked (pg_trigger_depth() = 1), so the path/in_valuable cascades the database makes itself still run;
--    jobs without a login (cron, the scale) are not people and are not checked.

-- ── 1. A secret per question ───────────────────────────────────────────────────
alter table public.ai_usage add column nonce_hash text check (nonce_hash is null or nonce_hash ~ '^[0-9a-f]{64}$');

alter function public.rpc_ask_begin(uuid, uuid) rename to rpc_ask_begin_v99;
alter function public.rpc_ask_begin_v99(uuid, uuid) set schema private;
revoke execute on function private.rpc_ask_begin_v99(uuid, uuid) from public, anon, authenticated;

create function public.rpc_ask_begin(p_household uuid, p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out   jsonb := private.rpc_ask_begin_v99(p_household, p_request);
  v_nonce text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  update public.ai_usage
     set nonce_hash = encode(sha256(convert_to(v_nonce, 'UTF8')), 'hex')
   where request_id = p_request and household_id = p_household and user_id = auth.uid() and error = 'pending';
  return v_out || jsonb_build_object('nonce', v_nonce);
end;
$$;
revoke execute on function public.rpc_ask_begin(uuid, uuid) from public, anon;
grant execute on function public.rpc_ask_begin(uuid, uuid) to authenticated;

alter function public.rpc_ask_record(uuid, uuid, jsonb) rename to rpc_ask_record_v99;
alter function public.rpc_ask_record_v99(uuid, uuid, jsonb) set schema private;
revoke execute on function private.rpc_ask_record_v99(uuid, uuid, jsonb) from public, anon, authenticated;

create function public.rpc_ask_record(p_household uuid, p_request uuid, p_nonce text, p_calls jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_household) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.ai_usage u
     where u.request_id = p_request and u.household_id = p_household and u.user_id = auth.uid()
       and u.error = 'pending' and u.nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex')
  ) then
    raise exception 'no question waiting' using errcode = '22023';
  end if;
  return private.rpc_ask_record_v99(p_household, p_request, p_calls);
end;
$$;
revoke execute on function public.rpc_ask_record(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.rpc_ask_record(uuid, uuid, text, jsonb) to authenticated;

-- ── 2. Hidden places on every definer path ─────────────────────────────────────
-- A person other than the owner, writing directly (not a cascade the database makes), not a job.
create function private.guard_applies(p_household uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and pg_trigger_depth() = 1 and not private.is_owner(p_household);
$$;
revoke execute on function private.guard_applies(uuid) from public, anon, authenticated;

create function private.guard_hidden_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.guard_applies(new.household_id)
     and (private.location_hidden(new.household_id, new.location_id)
          or (tg_op = 'UPDATE' and private.location_hidden(old.household_id, old.location_id))) then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  return new;
end;
$$;

create function private.guard_hidden_asset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.guard_applies(old.household_id)
     and (private.location_hidden(old.household_id, old.location_id)
          or (tg_op = 'UPDATE' and private.location_hidden(new.household_id, new.location_id))) then
    raise exception 'unknown item' using errcode = '23503';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function private.guard_hidden_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h uuid := case when tg_op = 'DELETE' then old.household_id else new.household_id end;
begin
  if private.guard_applies(v_h)
     and ((tg_op in ('UPDATE', 'DELETE') and old.in_valuable)
          or (tg_op in ('INSERT', 'UPDATE') and private.location_hidden(new.household_id, new.parent_id))) then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function private.guard_hidden_stock() from public, anon, authenticated;
revoke execute on function private.guard_hidden_asset() from public, anon, authenticated;
revoke execute on function private.guard_hidden_location() from public, anon, authenticated;

create trigger stock_lot_guard_hidden
  before insert or update on public.stock_lot
  for each row execute function private.guard_hidden_stock();
create trigger stock_movement_guard_hidden
  before insert on public.stock_movement
  for each row execute function private.guard_hidden_stock();
create trigger asset_guard_hidden
  before update or delete on public.asset
  for each row execute function private.guard_hidden_asset();
create trigger location_guard_hidden
  before insert or update or delete on public.location
  for each row execute function private.guard_hidden_location();

update public.app_meta set value = '102' where key = 'schema_version';
