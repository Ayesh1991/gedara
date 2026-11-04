-- Phase 10 · 103 — hidden places, second security review of migration 102
--
-- * A thing created inside a valuable place by a SECURITY DEFINER path (not only changed or deleted) is
--   refused for anyone but the owner: the asset guard now also runs on INSERT.
-- * Stock: a movement is checked against the place of the lot it belongs to as well as its own place, and
--   the stock guards no longer skip writes made by other triggers (pg_trigger_depth() > 1), so a lot in the
--   safe can't be changed through a movement that names no place. Only places keep the depth rule: renaming a
--   room must still re-path the safe inside it, which the database does by itself.

-- A person other than the owner (jobs without a login — cron, the scale — are not people).
create function private.guard_person(p_household uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and not private.is_owner(p_household);
$$;
revoke execute on function private.guard_person(uuid) from public, anon, authenticated;

create or replace function private.guard_hidden_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- a movement's lot (stock_lot rows have no lot_id; read it without naming the field)
  v_lot uuid := case when tg_table_name = 'stock_movement' then (to_jsonb(new) ->> 'lot_id')::uuid end;
begin
  if private.guard_person(new.household_id)
     and (private.location_hidden(new.household_id, new.location_id)
          or (tg_op = 'UPDATE' and private.location_hidden(old.household_id, old.location_id))
          or (v_lot is not null and private.location_hidden(new.household_id,
                (select s.location_id from public.stock_lot s where s.id = v_lot and s.household_id = new.household_id)))) then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  return new;
end;
$$;

create or replace function private.guard_hidden_asset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if private.guard_person(new.household_id) and private.location_hidden(new.household_id, new.location_id) then
      raise exception 'unknown place' using errcode = '23503';
    end if;
    return new;
  end if;
  if private.guard_person(old.household_id)
     and (private.location_hidden(old.household_id, old.location_id)
          or (tg_op = 'UPDATE' and private.location_hidden(new.household_id, new.location_id))) then
    raise exception 'unknown item' using errcode = '23503';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger asset_guard_hidden on public.asset;
create trigger asset_guard_hidden
  before insert or update or delete on public.asset
  for each row execute function private.guard_hidden_asset();

update public.app_meta set value = '103' where key = 'schema_version';
