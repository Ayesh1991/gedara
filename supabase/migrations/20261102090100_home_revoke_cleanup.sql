-- Phase 8b · 97 — disconnecting the Home Assistant bridge also removes what it reported.
--
-- rpc_device_revoke (migration 75) forgot the bridge's key but kept its home_entity rows, so after
-- disconnecting and connecting again the chooser and the House page showed the old bridge's doors
-- and sensors next to the new ones. Now they go with it (their commands cascade); the house log
-- keeps its history (home_event.entity becomes null). Leftovers of bridges removed earlier are
-- cleaned up once here.

create or replace function public.rpc_device_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select d.household_id into v_household from public.device d where d.id = p_id;
  if v_household is null or not private.is_owner(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.device d set revoked_at = coalesce(d.revoked_at, now()), live_state = null, watch_until = null
   where d.id = p_id;
  delete from public.device_token t where t.device_id = p_id;
  delete from public.media_token t where t.device_id = p_id;
  delete from public.home_token t where t.device_id = p_id;
  delete from public.home_entity h where h.device_id = p_id;
end;
$$;

delete from public.home_entity h using public.device d where d.id = h.device_id and d.revoked_at is not null;

update public.app_meta set value = '97' where key = 'schema_version';
