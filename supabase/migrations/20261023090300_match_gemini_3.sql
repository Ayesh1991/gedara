-- Phase 9 · 83 — the Gemini step is Gemini 3.8 Flash.
-- Gedara's Gemini key (a 2026 AI Studio project) answers 404 for the 2.5 models; 3.1 Flash-Lite, 3.6
-- and 3.8 Flash answer (live key test on staging, 2026-10-23). The default ladder (column default and
-- the first save of the settings) now names 3.8 Flash; a household that already saved its ladder keeps it.

alter table public.match_setting alter column steps set default
  '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"gemini","model":"gemini-3.8-flash"},{"provider":"openai","model":"gpt-5.4-mini"}]';

update public.match_setting s
   set steps = replace(s.steps::text, '"gemini-2.5-flash"', '"gemini-3.8-flash"')::jsonb, updated_at = now()
 where s.steps::text like '%"gemini-2.5-flash"%';

create or replace function public.rpc_match_settings_save(p_household uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_step jsonb;
begin
  if not private.is_owner(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p ? 'steps' then
    if jsonb_typeof(p -> 'steps') <> 'array' or jsonb_array_length(p -> 'steps') not between 1 and 3 then
      raise exception 'steps: 1 to 3 models' using errcode = '23514';
    end if;
    for v_step in select value from jsonb_array_elements(p -> 'steps') loop
      if v_step ->> 'provider' not in ('groq', 'gemini', 'openai')
         or coalesce(v_step ->> 'model', '') !~ '^[a-z0-9][a-z0-9./_-]{1,59}$' then
        raise exception 'unknown model' using errcode = '23514';
      end if;
    end loop;
  end if;
  insert into public.match_setting as s (household_id, ai_enabled, steps, monthly_cap_usd, daily_requests, updated_by)
  values (p_household, coalesce((p ->> 'ai_enabled')::boolean, false),
          coalesce(p -> 'steps', '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"gemini","model":"gemini-3.8-flash"},{"provider":"openai","model":"gpt-5.4-mini"}]'),
          coalesce((p ->> 'monthly_cap_usd')::numeric, 3), coalesce((p ->> 'daily_requests')::integer, 150), auth.uid())
  on conflict (household_id) do update
    set ai_enabled = coalesce((p ->> 'ai_enabled')::boolean, s.ai_enabled),
        steps = coalesce(p -> 'steps', s.steps),
        monthly_cap_usd = coalesce((p ->> 'monthly_cap_usd')::numeric, s.monthly_cap_usd),
        daily_requests = coalesce((p ->> 'daily_requests')::integer, s.daily_requests),
        updated_by = auth.uid(), updated_at = now();
end;
$$;

update public.app_meta set value = '83' where key = 'schema_version';
