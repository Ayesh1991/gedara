-- Phase 0 · 6 — move the RLS helpers out of the exposed API schema (Supabase advisor 0029).
-- They were callable as /rest/v1/rpc/is_member etc. Harmless (they only answer for the caller),
-- but helpers used by every policy belong in a schema the Data API doesn't expose.
-- Existing policies reference the functions by OID, so they keep working unchanged.
-- From here on, policies use private.is_member(household_id) / private.can_write(household_id).

create schema if not exists private;
revoke all on schema private from public;
-- Policies run with the caller's privileges, so authenticated needs usage + execute.
grant usage on schema private to authenticated;

alter function public.is_member(uuid) set schema private;
alter function public.can_write(uuid) set schema private;
alter function public.is_owner(uuid) set schema private;

update public.app_meta set value = '6' where key = 'schema_version';
