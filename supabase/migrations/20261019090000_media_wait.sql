-- Migration 74 · the speaker's long-poll waits inside the database (log budget, 2026-10-19).
--
-- media-agent used to call rpc_media_pending every 0.7 s while the speaker's request was open: about
-- 37 logged API requests per 25 s, ~128,000 a day per speaker, the largest steady share of the free
-- plan's 1 GB Log Ingestion. rpc_media_wait does the checking in Postgres instead: one request waits
-- up to 7 s (PostgREST's authenticator role has statement_timeout = 8s) and says whether there is
-- something for the speaker; only then does the function call rpc_media_pending to pick it up.
--
-- It is read-only and takes no locks: it finds the speaker without private.media_device_by_token
-- (that one locks the device row FOR UPDATE, which would hold the speaker's own reports and Gedara's
-- commands for the whole wait). Each loop statement takes a fresh snapshot (READ COMMITTED), so a
-- command committed by Gedara during the wait is seen within ~0.3 s.

create function public.rpc_media_wait(p_token_hash text, p_ms integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device uuid;
  v_until  timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_ms, 0), 100), 7000) / 1000.0);
begin
  select d.id into v_device from public.media_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null and d.kind = 'media';
  if v_device is null then
    raise exception 'unknown or removed speaker' using errcode = '42501';
  end if;
  loop
    -- The same tests as rpc_media_pending: a queued command, or a song to collect / delete.
    if exists (select 1 from public.media_command c where c.device_id = v_device and c.status = 'queued')
       or exists (select 1 from public.media_track t where t.device_id = v_device
                   and (t.state = 'waiting' or (t.state = 'deleting' and t.on_device))) then
      return true;
    end if;
    exit when clock_timestamp() >= v_until;
    perform pg_sleep(least(0.3, greatest(extract(epoch from v_until - clock_timestamp()), 0)));
  end loop;
  return false;
end;
$$;
revoke execute on function public.rpc_media_wait(text, integer) from public, anon, authenticated;
grant execute on function public.rpc_media_wait(text, integer) to service_role;

update public.app_meta set value = '74' where key = 'schema_version';
