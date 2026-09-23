-- Phase 0 · 3/5 — invite-only membership
-- Public sign-up is disabled; users are added in the dashboard (Auth → Users → Add user).
-- When an auth.users row appears whose email matches an open invite, the user joins that household.

-- Shared by the trigger and the backfill. Returns the number of memberships created.
create function public.accept_invites_for(p_user_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_email is null then
    return 0;
  end if;

  with open_invites as (
    update public.household_invite i
       set accepted_at = now()
     where i.email = lower(p_email)
       and i.accepted_at is null
    returning i.household_id, i.role, i.display_name
  ), inserted as (
    insert into public.household_member (household_id, user_id, role, display_name)
    select household_id, p_user_id, role, display_name from open_invites
    on conflict (household_id, user_id) do nothing
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.accept_invites_for(new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: users who were created before their invite existed (or before this migration).
create function public.accept_pending_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  r record;
begin
  for r in
    select u.id, u.email
      from auth.users u
      join public.household_invite i on i.email = lower(u.email) and i.accepted_at is null
  loop
    v_total := v_total + public.accept_invites_for(r.id, r.email);
  end loop;
  return v_total;
end;
$$;

-- Internal only: never callable through the API.
revoke execute on function public.accept_invites_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.accept_pending_invites() from public, anon, authenticated;

update public.app_meta set value = '3' where key = 'schema_version';
