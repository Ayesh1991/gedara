-- Phase 10 · 99 — Ask Gedara: the owner's switch, each person's daily limit, and usage
--
-- * match_setting.ask_enabled (off by default) and ask_daily_per_person (default 20, 0–100); only the
--   owner saves them (rpc_ask_settings_save).
-- * Ask's AI calls go into ai_usage (task 'ask', user_id, request_id), so the household's monthly AI
--   cap and the Matching cost table count them together with matching.
-- * rpc_ask_begin (called by the ask-gedara function with the asker's own login) checks membership
--   (viewers may ask), the switch, the asker's daily limit and the monthly cap, then writes a
--   'pending' row first, so parallel questions can't slip past the limit. rpc_ask_record fills it in.
-- * Nothing here stores a question, a plan or an answer: only counts, tokens, cost and an error code.

alter table public.match_setting
  add column ask_enabled boolean not null default false,
  add column ask_daily_per_person integer not null default 20 check (ask_daily_per_person between 0 and 100);

alter table public.ai_usage
  add column user_id    uuid references auth.users (id) on delete set null,
  add column request_id uuid;

create index ai_usage_ask_idx on public.ai_usage (household_id, user_id, at desc) where task = 'ask';
create index ai_usage_request_idx on public.ai_usage (request_id) where request_id is not null;

-- The start of the household's current month / day, as timestamps.
create function private.household_period_start(p_household uuid, p_unit text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select date_trunc(p_unit, now() at time zone h.timezone) at time zone h.timezone
    from public.household h where h.id = p_household;
$$;
revoke execute on function private.household_period_start(uuid, text) from public, anon, authenticated;

-- ── Owner saves the Ask settings ───────────────────────────────────────────────
-- p { ask_enabled?: boolean, ask_daily_per_person?: 0..100 }
create function public.rpc_ask_settings_save(p_household uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.match_setting;
begin
  if not private.is_owner(p_household) then
    raise exception 'only the owner can change Ask Gedara' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select count(*) from jsonb_object_keys(p) k where k not in ('ask_enabled', 'ask_daily_per_person')) > 0
     or (p ? 'ask_enabled' and jsonb_typeof(p -> 'ask_enabled') <> 'boolean')
     or (p ? 'ask_daily_per_person' and (jsonb_typeof(p -> 'ask_daily_per_person') <> 'number'
                                          or (p ->> 'ask_daily_per_person')::numeric not between 0 and 100
                                          or (p ->> 'ask_daily_per_person')::numeric <> trunc((p ->> 'ask_daily_per_person')::numeric))) then
    raise exception 'bad Ask settings' using errcode = '22023';
  end if;

  insert into public.match_setting as s (household_id, ask_enabled, ask_daily_per_person, updated_by)
  values (p_household, coalesce((p ->> 'ask_enabled')::boolean, false),
          coalesce((p ->> 'ask_daily_per_person')::integer, 20), auth.uid())
  on conflict (household_id) do update
    set ask_enabled = coalesce((p ->> 'ask_enabled')::boolean, s.ask_enabled),
        ask_daily_per_person = coalesce((p ->> 'ask_daily_per_person')::integer, s.ask_daily_per_person),
        updated_by = auth.uid(), updated_at = now()
  returning * into v_row;
  return jsonb_build_object('ask_enabled', v_row.ask_enabled, 'ask_daily_per_person', v_row.ask_daily_per_person);
end;
$$;
revoke execute on function public.rpc_ask_settings_save(uuid, jsonb) from public, anon;
grant execute on function public.rpc_ask_settings_save(uuid, jsonb) to authenticated;

-- ── What the asker may do today (for the screen; no side effects) ──────────────
create function public.rpc_ask_status(p_household uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s public.match_setting;
begin
  if not private.is_member(p_household) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select * into v_s from public.match_setting s where s.household_id = p_household;
  return jsonb_build_object(
    'enabled', coalesce(v_s.ask_enabled, false),
    'limit', coalesce(v_s.ask_daily_per_person, 20),
    'used', (select count(distinct u.request_id) from public.ai_usage u
              where u.household_id = p_household and u.task = 'ask' and u.user_id = auth.uid()
                and u.at >= private.household_period_start(p_household, 'day')),
    'cap_usd', coalesce(v_s.monthly_cap_usd, 0.90),
    'month_cost_usd', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u
                        where u.household_id = p_household and u.at >= private.household_period_start(p_household, 'month')));
end;
$$;
revoke execute on function public.rpc_ask_status(uuid) from public, anon;
grant execute on function public.rpc_ask_status(uuid) to authenticated;

-- ── Begin one question ─────────────────────────────────────────────────────────
-- Errors: 42501 not a member · GDAOF Ask is off · GDRTE daily limit · GDCAP monthly AI cap · 22023 bad id.
create function public.rpc_ask_begin(p_household uuid, p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     public.match_setting;
  v_used  integer;
  v_cost  numeric;
  v_steps jsonb;
  v_tz    text;
begin
  if not private.is_member(p_household) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_request is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;
  -- One question at a time per person, so the count below can't be raced.
  perform pg_advisory_xact_lock(hashtextextended('gedara.ask:' || auth.uid()::text, 0));

  select * into v_s from public.match_setting s where s.household_id = p_household;
  if not coalesce(v_s.ask_enabled, false) then
    raise exception 'Ask Gedara is off' using errcode = 'GDAOF';
  end if;
  if exists (select 1 from public.ai_usage u where u.request_id = p_request) then
    raise exception 'request already used' using errcode = '22023';
  end if;

  select count(distinct u.request_id) into v_used from public.ai_usage u
   where u.household_id = p_household and u.task = 'ask' and u.user_id = auth.uid()
     and u.at >= private.household_period_start(p_household, 'day');
  if v_used >= v_s.ask_daily_per_person then
    raise exception 'daily question limit reached' using errcode = 'GDRTE';
  end if;

  select coalesce(sum(u.cost_usd), 0) into v_cost from public.ai_usage u
   where u.household_id = p_household and u.at >= private.household_period_start(p_household, 'month');
  if v_cost >= v_s.monthly_cap_usd then
    raise exception 'monthly AI cap reached' using errcode = 'GDCAP';
  end if;

  -- Ask uses the household's Groq / OpenAI steps only (both don't train on API data); never Gemini.
  select coalesce(jsonb_agg(x.value order by x.ord), '[]') into v_steps
    from jsonb_array_elements(v_s.steps) with ordinality x (value, ord)
   where x.value ->> 'provider' in ('groq', 'openai');
  if jsonb_array_length(v_steps) = 0 then
    v_steps := '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"openai","model":"gpt-6-luna"}]'::jsonb;
  end if;

  insert into public.ai_usage (household_id, provider, model, task, ok, error, user_id, request_id)
  values (p_household, v_steps -> 0 ->> 'provider', v_steps -> 0 ->> 'model', 'ask', false, 'pending', auth.uid(), p_request);

  select h.timezone into v_tz from public.household h where h.id = p_household;
  return jsonb_build_object(
    'steps', v_steps,
    'today', (now() at time zone v_tz)::date,
    'used', v_used + 1,
    'limit', v_s.ask_daily_per_person);
end;
$$;
revoke execute on function public.rpc_ask_begin(uuid, uuid) from public, anon;
grant execute on function public.rpc_ask_begin(uuid, uuid) to authenticated;

-- ── Record the model calls of one question (counts only) ───────────────────────
-- p_calls: 1–2 of { provider: groq|openai, model, input_tokens, output_tokens, cost_usd ≤ 0.05, ok, error? }
create function public.rpc_ask_record(p_household uuid, p_request uuid, p_calls jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending uuid;
  v_call    jsonb;
  v_first   boolean := true;
begin
  if not private.is_member(p_household) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select u.id into v_pending from public.ai_usage u
   where u.request_id = p_request and u.household_id = p_household and u.user_id = auth.uid()
     and u.task = 'ask' and u.error = 'pending' and u.at > now() - interval '5 minutes';
  if v_pending is null then
    raise exception 'no question waiting' using errcode = '22023';
  end if;
  if jsonb_typeof(p_calls) <> 'array' or jsonb_array_length(p_calls) not between 1 and 2 then
    raise exception 'bad calls' using errcode = '22023';
  end if;
  for v_call in select value from jsonb_array_elements(p_calls) loop
    if jsonb_typeof(v_call) <> 'object'
       or coalesce(v_call ->> 'provider', '') not in ('groq', 'openai')
       or coalesce(v_call ->> 'model', '') !~ '^[a-z0-9][a-z0-9./_-]{1,59}$'
       or jsonb_typeof(v_call -> 'input_tokens') <> 'number' or (v_call ->> 'input_tokens')::numeric not between 0 and 200000
       or jsonb_typeof(v_call -> 'output_tokens') <> 'number' or (v_call ->> 'output_tokens')::numeric not between 0 and 50000
       or jsonb_typeof(v_call -> 'cost_usd') <> 'number' or (v_call ->> 'cost_usd')::numeric not between 0 and 0.05
       or jsonb_typeof(v_call -> 'ok') <> 'boolean'
       or (v_call ? 'error' and v_call -> 'error' <> 'null'::jsonb and coalesce(v_call ->> 'error', '') !~ '^[a-z0-9_]{1,30}$') then
      raise exception 'bad call' using errcode = '22023';
    end if;
    if v_first then
      update public.ai_usage
         set provider = v_call ->> 'provider', model = v_call ->> 'model',
             input_tokens = (v_call ->> 'input_tokens')::integer, output_tokens = (v_call ->> 'output_tokens')::integer,
             cost_usd = (v_call ->> 'cost_usd')::numeric, ok = (v_call ->> 'ok')::boolean, error = v_call ->> 'error'
       where id = v_pending;
      v_first := false;
    else
      insert into public.ai_usage (household_id, provider, model, task, input_tokens, output_tokens, cost_usd, ok, error,
                                   user_id, request_id)
      values (p_household, v_call ->> 'provider', v_call ->> 'model', 'ask', (v_call ->> 'input_tokens')::integer,
              (v_call ->> 'output_tokens')::integer, (v_call ->> 'cost_usd')::numeric, (v_call ->> 'ok')::boolean,
              v_call ->> 'error', auth.uid(), p_request);
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.rpc_ask_record(uuid, uuid, jsonb) from public, anon;
grant execute on function public.rpc_ask_record(uuid, uuid, jsonb) to authenticated;

update public.app_meta set value = '99' where key = 'schema_version';
