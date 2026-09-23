-- Phase 0 · 5/5 — the Gedara household and its two invites (MASTER_PLAN §11.2)
-- Idempotent, and applied to staging and prod alike so prod is seeded by migration only (rule 3).

do $$
declare
  v_household uuid;
begin
  select id into v_household from public.household where name = 'Gedara' order by created_at limit 1;

  if v_household is null then
    insert into public.household (name, currency, locale, timezone)
    values ('Gedara', 'LKR', 'en-LK', 'Asia/Colombo')
    returning id into v_household;
  end if;

  insert into public.household_invite (household_id, email, role, display_name)
  values
    (v_household, 'ayeshmantha@gmail.com',       'owner',  'Didula Ayeshmantha'),
    (v_household, 'asithaathennakoon@gmail.com', 'member', 'Sandeepani Thennakoon')
  on conflict (household_id, email) do nothing;
end;
$$;

-- Users already added in the dashboard before this migration join now.
select public.accept_pending_invites();

update public.app_meta set value = '5' where key = 'schema_version';
