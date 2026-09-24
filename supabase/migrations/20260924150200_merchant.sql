-- Phase 2 · 13 — merchants (MASTER_PLAN §3.2)
-- "Cargills Food City", "Keells", "LAUGFS". Bill import resolves a shop name to a merchant by its
-- normalised name or an alias, creating one when it's new. The printed shop name also stays on the
-- transaction (`payee_text`) exactly as scanned.

create function private.norm_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

grant execute on function private.norm_name(text) to authenticated;

create table public.merchant (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 80),
  name_norm     text generated always as (private.norm_name(name)) stored,
  aliases       text[] not null default '{}',   -- normalised (lower-case, single spaces)
  kind          text check (kind in ('supermarket', 'grocery', 'pharmacy', 'restaurant', 'fuel', 'utility',
                                     'online', 'hardware', 'clothing', 'services', 'other')),
  location_text text check (length(location_text) <= 120),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, name_norm)
);

create index merchant_aliases_idx on public.merchant using gin (aliases);

create trigger merchant_updated_at
  before update on public.merchant
  for each row execute function private.set_updated_at();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.merchant enable row level security;

revoke all on table public.merchant from anon, authenticated;
grant select, delete on table public.merchant to authenticated;
grant insert (household_id, name, aliases, kind, location_text) on table public.merchant to authenticated;
grant update (name, aliases, kind, location_text) on table public.merchant to authenticated;

create policy merchant_select on public.merchant
  for select to authenticated
  using (private.is_member(household_id));

create policy merchant_insert on public.merchant
  for insert to authenticated
  with check (private.can_write(household_id));

create policy merchant_update on public.merchant
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy merchant_delete on public.merchant
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '13' where key = 'schema_version';
