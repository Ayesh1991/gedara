-- Phase 6 · 49 — daily jobs at 07:00 Asia/Colombo (01:30 UTC; Sri Lanka has no daylight saving)
--   gedara-attention-push  POST the attention-push Edge Function with the Vault cron token
--   gedara-housekeeping    old dismissals, push runs and cron run logs
-- The function's URL differs per project, so it is read from the Vault secret `project_url`, created
-- once per project by hand (see docs/decisions.md 2026-09-25). Without it the job only logs a notice.

create function private.run_attention_push()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_token text := private.cron_token();
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  if v_url is null or v_token is null then
    raise notice 'attention push skipped: Vault secret project_url (or the cron token) is missing';
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/attention-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Gedara-Cron', v_token),
    body := jsonb_build_object('run', 'daily'),
    timeout_milliseconds := 30000);
end;
$$;

create function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.attention_dismissal d
   where (d.hidden_until is not null and d.hidden_until < current_date - 7)
      or (d.hidden_until is null and d.created_at < now() - interval '180 days');
  delete from public.push_run r where r.run_on < current_date - 180;
  delete from cron.job_run_details j where j.end_time < now() - interval '30 days';
end;
$$;

revoke execute on function private.run_attention_push() from public, anon, authenticated;
revoke execute on function private.housekeeping() from public, anon, authenticated;

select cron.schedule('gedara-attention-push', '30 1 * * *', 'select private.run_attention_push()');
select cron.schedule('gedara-housekeeping', '35 1 * * *', 'select private.housekeeping()');

-- ── Diagnostics: is the daily push set up and did it run? ─────────────────────
create function public.attention_push_status(p_household uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run  public.push_run%rowtype;
  v_job  record;
begin
  if not private.is_member(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select r.* into v_run from public.push_run r where r.household_id = p_household order by r.run_on desc limit 1;
  select d.status, d.start_time, d.return_message into v_job
    from cron.job_run_details d
    join cron.job c on c.jobid = d.jobid
   where c.jobname = 'gedara-attention-push'
   order by d.start_time desc limit 1;
  return jsonb_build_object(
    'scheduled', exists (select 1 from cron.job c where c.jobname = 'gedara-attention-push' and c.active),
    'project_url_set', exists (select 1 from vault.secrets s where s.name = 'project_url'),
    'last_job', case when v_job.start_time is null then null
                     else jsonb_build_object('status', v_job.status, 'at', v_job.start_time,
                                             'message', left(v_job.return_message, 200)) end,
    'last_run', case when v_run.id is null then null
                     else jsonb_build_object('run_on', v_run.run_on, 'items', v_run.items, 'sent', v_run.sent,
                                             'failed', v_run.failed, 'finished_at', v_run.finished_at) end);
end;
$$;

revoke execute on function public.attention_push_status(uuid) from public, anon;
grant execute on function public.attention_push_status(uuid) to authenticated;

update public.app_meta set value = '49' where key = 'schema_version';
