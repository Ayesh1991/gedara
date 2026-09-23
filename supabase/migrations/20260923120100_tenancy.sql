-- Phase 0 · 2/5 — household tenancy + RLS helpers (MASTER_PLAN §3.1)
-- Everything in Gedara belongs to a household; users are members.
-- Membership is created only by the invite trigger (next migration), never by the client.

create table public.household (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  currency   text not null default 'LKR',
  locale     text not null default 'en-LK',
  timezone   text not null default 'Asia/Colombo',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.household_member (
  household_id uuid not null references public.household (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('owner', 'member', 'viewer')),
  display_name text,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
-- RLS helpers look up by (household_id, user_id) → PK covers it; this one serves "my households".
create index household_member_user_id_idx on public.household_member (user_id);

create table public.household_invite (
  household_id uuid not null references public.household (id) on delete cascade,
  email        text not null check (email = lower(email) and position('@' in email) > 1),
  role         text not null check (role in ('owner', 'member', 'viewer')),
  display_name text,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (household_id, email)
);
create index household_invite_email_idx on public.household_invite (email) where accepted_at is null;

-- ── RLS helpers ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so policies on household_member don't recurse into themselves.
-- Both only ever answer for the calling user (auth.uid()), so exposing them as RPCs leaks nothing.

create function public.is_member(h uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_member m
    where m.household_id = h and m.user_id = (select auth.uid())
  )
$$;

-- Writers = owner or member. Viewers are read-only (pattern for every later table's
-- insert/update/delete policies).
create function public.can_write(h uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_member m
    where m.household_id = h and m.user_id = (select auth.uid()) and m.role in ('owner', 'member')
  )
$$;

create function public.is_owner(h uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_member m
    where m.household_id = h and m.user_id = (select auth.uid()) and m.role = 'owner'
  )
$$;

revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.can_write(uuid) from public, anon;
revoke execute on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.can_write(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table public.household enable row level security;
alter table public.household_member enable row level security;
alter table public.household_invite enable row level security;

-- Defence in depth: anon never touches tenancy tables; authenticated gets only what policies allow.
revoke all on table public.household, public.household_member, public.household_invite from anon;
revoke all on table public.household, public.household_member, public.household_invite from authenticated;
grant select, update on table public.household to authenticated;
grant select on table public.household_member to authenticated;
grant select on table public.household_invite to authenticated;

create policy household_select on public.household
  for select to authenticated
  using ((select public.is_member(id)));

create policy household_update on public.household
  for update to authenticated
  using ((select public.is_owner(id)))
  with check ((select public.is_owner(id)));

create policy household_member_select on public.household_member
  for select to authenticated
  using ((select public.is_member(household_id)));

create policy household_invite_select on public.household_invite
  for select to authenticated
  using ((select public.is_owner(household_id)));

update public.app_meta set value = '2' where key = 'schema_version';
