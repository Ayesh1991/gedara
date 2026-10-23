-- Phase 9 · 82 — "Test the AI keys" is the owner's, like the accuracy test.
-- Migration 80 let the key test ride on the 'user' trigger ("Check now"), so any member could start
-- paid AI calls, and the test didn't look at the monthly cap. Now it has its own trigger 'check':
-- owner only, once a minute; the function also refuses it when the month's cap is reached.

alter table public.match_run drop constraint match_run_trigger_check;
alter table public.match_run add constraint match_run_trigger_check
  check (trigger in ('cron', 'user', 'import', 'eval', 'check'));

create or replace function public.rpc_match_request(p_household uuid, p_trigger text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_trigger not in ('user', 'import', 'eval', 'check') then
    raise exception 'unknown trigger' using errcode = '22023';
  end if;
  if not private.can_write(p_household)
     or (p_trigger in ('eval', 'check') and not private.is_owner(p_household)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_trigger in ('user', 'check') and exists (select 1 from public.match_run r where r.household_id = p_household
        and r.trigger = p_trigger and r.started_at > now() - interval '1 minute'))
     or (p_trigger = 'eval' and exists (select 1 from public.match_run r where r.household_id = p_household
        and r.trigger = 'eval' and r.started_at > now() - interval '20 seconds'))
     or (p_trigger = 'import' and (select count(*) from public.match_run r where r.household_id = p_household
        and r.trigger = 'import' and r.started_at > now() - interval '1 hour') >= 30) then
    raise exception 'too often' using errcode = 'GDRTE';
  end if;
  insert into public.match_run (household_id, trigger, started_by) values (p_household, p_trigger, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

update public.app_meta set value = '82' where key = 'schema_version';
