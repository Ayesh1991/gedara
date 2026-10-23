-- Phase 9 · 84 — AI under US$1 a month (Didula, 2026-10-23).
--   * the ladder is cheapest first: Groq gpt-oss-120b (free) → OpenAI gpt-6-luna ($0.10 / $0.50 per 1M
--     tokens) → Gemini 3.8 Flash ($0.75 / $3.75, $1.50 / $7.50 from 2027) only as the referee when the
--     first two disagree (all three answered the live key test on staging);
--   * the monthly cap defaults to US$0.90, and households above it come down to it. Costs are counted
--     at each model's highest announced price, so the real bill stays below the cap.

alter table public.match_setting alter column steps set default '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"openai","model":"gpt-6-luna"},{"provider":"gemini","model":"gemini-3.8-flash"}]';
alter table public.match_setting alter column monthly_cap_usd set default 0.90;

update public.match_setting s
   set steps = '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"openai","model":"gpt-6-luna"},{"provider":"gemini","model":"gemini-3.8-flash"}]'::jsonb, updated_at = now()
 where s.steps = '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"gemini","model":"gemini-3.8-flash"},{"provider":"openai","model":"gpt-5.4-mini"}]'::jsonb;
update public.match_setting s set monthly_cap_usd = 0.90, updated_at = now() where s.monthly_cap_usd > 0.90;

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
          coalesce(p -> 'steps', '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"openai","model":"gpt-6-luna"},{"provider":"gemini","model":"gemini-3.8-flash"}]'),
          coalesce((p ->> 'monthly_cap_usd')::numeric, 0.90), coalesce((p ->> 'daily_requests')::integer, 150), auth.uid())
  on conflict (household_id) do update
    set ai_enabled = coalesce((p ->> 'ai_enabled')::boolean, s.ai_enabled),
        steps = coalesce(p -> 'steps', s.steps),
        monthly_cap_usd = coalesce((p ->> 'monthly_cap_usd')::numeric, s.monthly_cap_usd),
        daily_requests = coalesce((p ->> 'daily_requests')::integer, s.daily_requests),
        updated_by = auth.uid(), updated_at = now();
end;
$$;

update public.app_meta set value = '84' where key = 'schema_version';
