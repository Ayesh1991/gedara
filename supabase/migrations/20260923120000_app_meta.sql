-- Phase 0 · 1/5 — app_meta + schema_version()
-- Global system table (no household_id): the one documented exception to rule 2.
-- It holds only non-sensitive build metadata shown on the Diagnostics page and the footer badge.
-- Every later migration ends by bumping schema_version.

create table public.app_meta (
  key   text primary key,
  value text not null
);

alter table public.app_meta enable row level security;
-- No policies on purpose: clients never read or write app_meta directly.
revoke all on table public.app_meta from anon, authenticated;

create function public.schema_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select value::integer from public.app_meta where key = 'schema_version'
$$;

revoke execute on function public.schema_version() from public;
grant execute on function public.schema_version() to anon, authenticated;

insert into public.app_meta (key, value) values ('schema_version', '1');
