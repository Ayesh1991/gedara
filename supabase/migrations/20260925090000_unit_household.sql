-- Phase 3 · 22 — household units (MASTER_PLAN §3.2)
-- Migration 11 created the system units (g, kg, ml, L, pcs, pack …) read-only. A household can now
-- add its own ("tin", "sachet", "dozen" = 12 pcs). A unit's dimension and size (`to_base`) never
-- change after creation: stock quantities and prices per base unit depend on them. Deleting a unit
-- that anything uses is blocked by the foreign keys pointing at it.

grant insert (household_id, code, name, dimension, to_base, aliases) on table public.unit to authenticated;
grant update (name, aliases) on table public.unit to authenticated;
grant delete on table public.unit to authenticated;

-- System units (household_id null) stay out of every write policy.
create policy unit_insert on public.unit
  for insert to authenticated
  with check (household_id is not null and private.can_write(household_id));

create policy unit_update on public.unit
  for update to authenticated
  using (household_id is not null and private.can_write(household_id))
  with check (household_id is not null and private.can_write(household_id));

create policy unit_delete on public.unit
  for delete to authenticated
  using (household_id is not null and private.can_write(household_id));

-- Trim code/name and keep aliases lower-case, trimmed and non-empty (the bill-line lookup matches
-- `lower(unit_text) = any (aliases)`).
create function private.unit_normalise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.code := btrim(new.code);
  new.name := btrim(new.name);
  new.aliases := coalesce(
    (select array_agg(distinct a) from (
       select lower(btrim(x)) as a from unnest(new.aliases) x
     ) s where a <> ''),
    '{}');
  return new;
end;
$$;

create trigger unit_normalise
  before insert or update of code, name, aliases on public.unit
  for each row execute function private.unit_normalise();

-- Helper for the tables below: a unit is usable by a household if it is a system unit or its own.
create function private.unit_usable(p_unit uuid, p_household uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_unit is null or exists (
    select 1 from public.unit u
     where u.id = p_unit and (u.household_id is null or u.household_id = p_household)
  )
$$;

-- Called from row triggers that run as the client; it only answers for a unit id it is given.
revoke execute on function private.unit_usable(uuid, uuid) from public, anon;
grant execute on function private.unit_usable(uuid, uuid) to authenticated;

update public.app_meta set value = '22' where key = 'schema_version';
