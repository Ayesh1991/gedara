-- Phase 7 · 52 — HL:LOT codes for lot labels (MASTER_PLAN §3.8, §7c template sq20-lot)
-- Only lots that get a label need a code, so it is assigned on demand by rpc_lot_code and never
-- changes afterwards (a printed label must keep its meaning). When part of a labelled lot is opened
-- or moved, the split-off part is a new lot without a code; the label stays with the original.

alter table public.stock_lot
  add column code text unique check (code ~ '^HL:LOT:[0-9A-HJKMNP-TV-Z]{6}$');

create function private.stock_lot_code_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.code is not null and new.code is distinct from old.code then
    raise exception 'a lot code never changes' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger stock_lot_code_immutable
  before update of code on public.stock_lot
  for each row execute function private.stock_lot_code_immutable();

-- Returns the lot's code, creating it the first time.
create function public.rpc_lot_code(p_lot uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_lot%rowtype;
begin
  select * into v from public.stock_lot l where l.id = p_lot for update;
  if not found or not private.is_member(v.household_id) then
    raise exception 'unknown lot' using errcode = '23503';
  end if;
  if v.code is not null then
    return v.code;
  end if;
  if not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.stock_lot l
     set code = private.new_hl_code('LOT', 'public.stock_lot')
   where l.id = p_lot
  returning l.code into v.code;
  return v.code;
end;
$$;

revoke execute on function private.stock_lot_code_immutable() from public, anon, authenticated;
revoke execute on function public.rpc_lot_code(uuid) from public, anon;
grant execute on function public.rpc_lot_code(uuid) to authenticated;

update public.app_meta set value = '52' where key = 'schema_version';
