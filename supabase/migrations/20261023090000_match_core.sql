-- Phase 9 · 80 — matching that runs by itself, AI in shadow (9b).
--
-- The match-agent Edge Function (twice a day by pg_cron, or "Check now") reads one bundle per
-- household (rpc_match_bundle), runs the shared rules (supabase/functions/_shared/match) and, for what
-- the rules can't settle, the AI ladder (_shared/ai: Groq → Gemini → OpenAI), and writes one result
-- (rpc_match_save): suggestions, token / cost rows, accuracy rows. Nothing is booked here — a person
-- accepts, changes or rejects every suggestion (rpc_match_decide); 9c adds per-kind auto-booking only
-- for kinds whose measured accuracy allows it.
--   * match_setting    — AI on/off, the model ladder, the monthly cost cap and a daily request cap
--   * match_suggestion — one open suggestion per (task, target); its pattern ("rule+ai1+ai2") and the
--                        models that agreed, so accuracy can be reported per pattern
--   * ai_usage         — tokens and cost per AI call (never any content)
--   * match_run        — every run (cron / user / import / eval) with its counts
--   * match_eval       — the accuracy test: a known answer, what the rules and the AI said
-- The bundle never contains an SMS body: the AI gateway can't send what it never gets.

-- ── Settings ──────────────────────────────────────────────────────────────────
create table public.match_setting (
  household_id    uuid primary key references public.household (id) on delete cascade,
  ai_enabled      boolean not null default false,
  steps           jsonb not null default
    '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"gemini","model":"gemini-2.5-flash"},{"provider":"openai","model":"gpt-5.4-mini"}]',
  monthly_cap_usd numeric(8,2) not null default 3 check (monthly_cap_usd between 0 and 50),
  daily_requests  integer not null default 150 check (daily_requests between 0 and 1000),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 3)
);

-- ── Suggestions ───────────────────────────────────────────────────────────────
create table public.match_suggestion (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  task         text not null check (task in ('line_product', 'line_category', 'line_thing', 'sms_category', 'sms_link')),
  target_key   text not null check (length(target_key) between 1 and 120), -- line fingerprint / sms id
  line_id      uuid,
  sms_id       uuid,
  proposal     jsonb not null check (jsonb_typeof(proposal) = 'object'),
  confidence   numeric(4,3) not null check (confidence between 0 and 1),
  pattern      text not null check (length(pattern) <= 60),
  models       text[] not null default '{}',
  input_hash   text not null check (length(input_hash) <= 40),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'changed', 'rejected', 'stale')),
  correction   jsonb,
  decided_by   uuid,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, task, target_key),
  foreign key (household_id, line_id) references public.transaction_line (household_id, id) on delete cascade,
  foreign key (household_id, sms_id) references public.sms_message (household_id, id) on delete cascade
);
create index match_suggestion_pending_idx on public.match_suggestion (household_id, task) where status = 'pending';

-- ── Runs, usage, accuracy ─────────────────────────────────────────────────────
create table public.match_run (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  trigger      text not null check (trigger in ('cron', 'user', 'import', 'eval')),
  started_by   uuid,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}',
  unique (household_id, id)
);
create index match_run_recent_idx on public.match_run (household_id, started_at desc);

create table public.ai_usage (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  run_id        uuid,
  at            timestamptz not null default now(),
  provider      text not null check (provider in ('groq', 'gemini', 'openai')),
  model         text not null check (length(model) <= 60),
  task          text not null check (length(task) <= 30),
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd      numeric(10,6) not null default 0 check (cost_usd >= 0),
  ok            boolean not null,
  error         text check (length(error) <= 30),
  foreign key (household_id, run_id) references public.match_run (household_id, id) on delete set null (run_id)
);
create index ai_usage_at_idx on public.ai_usage (household_id, at desc);

create table public.match_eval (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  task         text not null check (task in ('line_product', 'line_category', 'sms_category', 'sms_link')),
  target_key   text not null check (length(target_key) between 1 and 120),
  truth        jsonb not null,
  rule         jsonb,            -- { answer, sure }
  ai           jsonb,            -- { answer, confidence, pattern, models }
  rule_correct boolean,
  ai_correct   boolean,
  created_at   timestamptz not null default now(),
  unique (household_id, task, target_key)
);

-- ── RLS: members read; every write goes through an RPC ───────────────────────
alter table public.match_setting enable row level security;
alter table public.match_suggestion enable row level security;
alter table public.match_run enable row level security;
alter table public.ai_usage enable row level security;
alter table public.match_eval enable row level security;

revoke all on table public.match_setting, public.match_suggestion, public.match_run, public.ai_usage, public.match_eval
  from anon, authenticated;
grant select on table public.match_setting, public.match_suggestion, public.match_run, public.ai_usage, public.match_eval
  to authenticated;

create policy match_setting_select on public.match_setting for select to authenticated using (private.is_member(household_id));
create policy match_suggestion_select on public.match_suggestion for select to authenticated using (private.is_member(household_id));
create policy match_run_select on public.match_run for select to authenticated using (private.is_member(household_id));
create policy ai_usage_select on public.ai_usage for select to authenticated using (private.is_member(household_id));
create policy match_eval_select on public.match_eval for select to authenticated using (private.is_member(household_id));

-- ── Owner: settings ───────────────────────────────────────────────────────────
-- p: { ai_enabled?, steps?, monthly_cap_usd?, daily_requests? }
create function public.rpc_match_settings_save(p_household uuid, p jsonb)
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
          coalesce(p -> 'steps', '[{"provider":"groq","model":"openai/gpt-oss-120b"},{"provider":"gemini","model":"gemini-2.5-flash"},{"provider":"openai","model":"gpt-5.4-mini"}]'),
          coalesce((p ->> 'monthly_cap_usd')::numeric, 3), coalesce((p ->> 'daily_requests')::integer, 150), auth.uid())
  on conflict (household_id) do update
    set ai_enabled = coalesce((p ->> 'ai_enabled')::boolean, s.ai_enabled),
        steps = coalesce(p -> 'steps', s.steps),
        monthly_cap_usd = coalesce((p ->> 'monthly_cap_usd')::numeric, s.monthly_cap_usd),
        daily_requests = coalesce((p ->> 'daily_requests')::integer, s.daily_requests),
        updated_by = auth.uid(), updated_at = now();
end;
$$;

-- ── Members: decide a suggestion ──────────────────────────────────────────────
-- accepted = done as suggested; changed = done differently (p_correction says how); rejected = not that.
create function public.rpc_match_decide(p_ids uuid[], p_status text, p_correction jsonb default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
begin
  if p_status not in ('accepted', 'changed', 'rejected') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  select min(s.household_id::text)::uuid into v_household from public.match_suggestion s
   where s.id = any (p_ids)
  having count(distinct s.household_id) = 1 and count(*) = cardinality(p_ids);
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.match_suggestion s
     set status = p_status, correction = p_correction, decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where s.id = any (p_ids) and s.status = 'pending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── Members: ask for a run (the function then works with the service role) ──
-- 'user' ("Check now") at most once a minute; 'import' (a bill being imported) 30 an hour; 'eval'
-- (the accuracy test, owner only) once every 20 s while it works through its batches.
create function public.rpc_match_request(p_household uuid, p_trigger text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_trigger not in ('user', 'import', 'eval') then
    raise exception 'unknown trigger' using errcode = '22023';
  end if;
  if not private.can_write(p_household) or (p_trigger = 'eval' and not private.is_owner(p_household)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_trigger = 'user' and exists (select 1 from public.match_run r where r.household_id = p_household
        and r.trigger = 'user' and r.started_at > now() - interval '1 minute'))
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

-- ── Cron: one run per household ───────────────────────────────────────────────
create function public.rpc_match_cron_begin(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  perform private.check_cron_token(p_token);
  with runs as (
    insert into public.match_run (household_id, trigger)
    select h.id, 'cron' from public.household h
    returning household_id, id
  )
  select coalesce(jsonb_agg(jsonb_build_object('household_id', household_id, 'run_id', id)), '[]') into v_out from runs;
  return v_out;
end;
$$;

-- ── The bundle: everything one run needs (service role only) ─────────────────
-- p_mode 'run' = open work; 'eval' = items with a known answer (the accuracy test).
create function public.rpc_match_bundle(p_household uuid, p_run uuid, p_mode text default 'run')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
  v_tz  text;
begin
  if not exists (select 1 from public.match_run r where r.id = p_run and r.household_id = p_household and r.finished_at is null) then
    raise exception 'no such run' using errcode = '42501';
  end if;
  select h.timezone into v_tz from public.household h where h.id = p_household;

  v_out := jsonb_build_object(
    'settings', coalesce((select to_jsonb(s) - 'household_id' from public.match_setting s where s.household_id = p_household),
                         '{"ai_enabled": false}'::jsonb),
    'usage', jsonb_build_object(
      'month_cost_usd', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u where u.household_id = p_household
                           and u.at >= date_trunc('month', now() at time zone v_tz) at time zone v_tz),
      'today', (select coalesce(jsonb_object_agg(x.provider, x.n), '{}') from (
                  select u.provider, count(*) as n from public.ai_usage u where u.household_id = p_household
                     and u.at >= date_trunc('day', now() at time zone v_tz) at time zone v_tz group by u.provider) x)),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'is_suspense', a.is_suspense,
                   'archived', a.archived, 'credit_limit', a.credit_limit, 'institution', a.institution)), '[]')
                   from public.account a where a.household_id = p_household),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'parent_id', c.parent_id, 'key', c.key, 'name', c.name,
                     'kind', c.kind, 'default_destiny', c.default_destiny, 'archived', c.archived)), '[]')
                     from public.category c where c.household_id = p_household),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'name_si', p.name_si,
                   'archived', p.archived, 'category_id', p.category_id)), '[]')
                   from public.product p where p.household_id = p_household and p.merged_into_id is null),
    'aliases', (select coalesce(jsonb_agg(jsonb_build_object('alias_norm', a.alias_norm, 'product_id', a.product_id, 'destiny', a.destiny)), '[]')
                  from public.product_alias a where a.household_id = p_household),
    'held', (select coalesce(jsonb_agg(distinct l.holds_product_id), '[]') from public.location l
               where l.household_id = p_household and l.holds_product_id is not null),
    'merchant_memory', (select coalesce(jsonb_agg(jsonb_build_object('merchant_norm', m.merchant_norm, 'category_id', m.category_id,
                          'account_id', m.account_id)), '[]') from public.merchant_memory m where m.household_id = p_household),
    'line_memory', (select coalesce(jsonb_agg(jsonb_build_object('name_norm', m.name_norm, 'category_id', m.category_id)), '[]')
                      from public.line_memory m where m.household_id = p_household),
    'suggestions', (select coalesce(jsonb_agg(jsonb_build_object('task', s.task, 'target_key', s.target_key,
                      'input_hash', s.input_hash, 'status', s.status)), '[]')
                      from public.match_suggestion s where s.household_id = p_household));

  if p_mode = 'run' then
    v_out := v_out || jsonb_build_object(
      -- waiting alerts: parsed fields only, never the body
      'sms', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'sender', s.sender, 'body', '', 'received_at', s.received_at,
                'fingerprint', s.fingerprint, 'kind', s.kind, 'parser', s.parser, 'institution', s.institution,
                'last_digits', s.last_digits, 'account_id', s.account_id, 'amount', s.amount, 'currency', s.currency,
                'balance_after', s.balance_after, 'merchant_text', s.merchant_text, 'bank_txn_id', s.bank_txn_id,
                'occurred_on', s.occurred_on, 'occurred_at', s.occurred_at, 'transaction_id', s.transaction_id,
                'ignored', s.ignored) order by s.received_at), '[]')
                from public.sms_message s
               where s.household_id = p_household
                 and s.received_at > now() - interval '120 days'),
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'type', t.type, 'account_id', t.account_id,
                       'to_account_id', t.to_account_id, 'payee_text', t.payee_text, 'occurred_on', t.occurred_on,
                       'occurred_at', t.occurred_at, 'total', t.total)), '[]')
                       from public.money_transaction t
                      where t.household_id = p_household and t.related_id is null
                        and t.type in ('expense', 'income', 'refund', 'transfer')
                        and t.occurred_on > (now() at time zone v_tz)::date - 130),
      'linked', (select coalesce(jsonb_agg(distinct s.transaction_id), '[]') from public.sms_message s
                  where s.household_id = p_household and s.transaction_id is not null),
      -- pantry lines still without a product (newest first)
      'lines', (select coalesce(jsonb_agg(x order by x ->> 'occurred_on' desc), '[]') from (
                  select jsonb_build_object('id', l.id, 'fingerprint', l.fingerprint, 'raw_name', l.raw_name, 'qty', l.qty,
                           'unit_text', l.unit_text, 'amount', l.amount, 'category_id', l.category_id, 'destiny', l.destiny,
                           'shop', coalesce(m.name, t.payee_text), 'occurred_on', t.occurred_on) as x
                    from public.transaction_line l
                    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
                    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
                   where l.household_id = p_household and l.destiny = 'stock' and l.product_id is null and l.amount > 0
                     and t.type = 'expense'
                   order by t.occurred_on desc limit 200) q),
      -- lines left in a catch-all ("Other …") sub-category
      'other_lines', (select coalesce(jsonb_agg(x), '[]') from (
                  select jsonb_build_object('id', l.id, 'fingerprint', l.fingerprint, 'raw_name', l.raw_name, 'qty', l.qty,
                           'unit_text', l.unit_text, 'amount', l.amount, 'category_id', l.category_id, 'destiny', l.destiny,
                           'shop', coalesce(m.name, t.payee_text), 'occurred_on', t.occurred_on) as x
                    from public.transaction_line l
                    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
                    join public.category c on c.id = l.category_id and c.household_id = l.household_id
                    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
                   where l.household_id = p_household and t.type = 'expense' and l.amount > 0 and l.destiny = 'expense'
                     and c.parent_id is not null and c.name ilike 'other%'
                   order by t.occurred_on desc limit 150) q),
      'things', (select coalesce(jsonb_agg(jsonb_build_object('id', v.line_id, 'raw_name', v.raw_name, 'amount', v.amount,
                   'category_id', v.category_id, 'shop', v.payee_text, 'occurred_on', v.occurred_on)), '[]')
                   from (select * from public.v_asset_pending_line v where v.household_id = p_household
                          order by v.occurred_on desc limit 50) v));
  elsif p_mode = 'eval' then
    v_out := v_out || jsonb_build_object(
      -- what this test already did (the last 6 hours): the test runs in batches, one call each
      'evaluated', (select coalesce(jsonb_agg(e.task || ':' || e.target_key), '[]') from public.match_eval e
                     where e.household_id = p_household and e.created_at > now() - interval '6 hours'),
      -- a person chose these products (an import with a product, or "Send to pantry")
      'eval_lines', (select coalesce(jsonb_agg(x), '[]') from (
                  select jsonb_build_object('id', l.id, 'fingerprint', l.fingerprint, 'raw_name', l.raw_name, 'qty', l.qty,
                           'unit_text', l.unit_text, 'amount', l.amount, 'category_id', l.category_id, 'destiny', l.destiny,
                           'product_id', l.product_id, 'shop', coalesce(m.name, t.payee_text), 'occurred_on', t.occurred_on) as x
                    from public.transaction_line l
                    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
                    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
                   where l.household_id = p_household and l.amount > 0 and t.type = 'expense'
                     and (l.product_id is not null or l.destiny = 'asset')
                   order by t.occurred_on desc limit 150) q),
      -- a person picked the category of these alert expenses in the inbox
      'eval_sms', (select coalesce(jsonb_agg(x), '[]') from (
                  select jsonb_build_object('id', s.id, 'merchant_text', s.merchant_text, 'amount', t.total, 'kind', s.kind,
                           'category_id', (select l.category_id from public.transaction_line l
                                            where l.transaction_id = t.id and l.household_id = t.household_id
                                            order by l.line_no limit 1)) as x
                    from public.sms_message s
                    join public.money_transaction t on t.id = s.transaction_id and t.household_id = s.household_id
                   where s.household_id = p_household and t.source = 'sms' and t.type = 'expense'
                     and s.merchant_text is not null
                   order by s.received_at desc limit 150) q));
  end if;
  return v_out;
end;
$$;

-- ── The result of a run (service role only) ───────────────────────────────────
-- p: { suggestions: [{ task, target_key, line_id?, sms_id?, proposal, confidence, pattern, models, input_hash }],
--      usage: [{ provider, model, task, input_tokens, output_tokens, cost_usd, ok, error }],
--      evals: [{ task, target_key, truth, rule, ai, rule_correct, ai_correct }],
--      stale: [{ task, target_key }], stats: {…} }
-- A suggestion a person already decided is only replaced when its input changed (new input_hash).
create function public.rpc_match_save(p_household uuid, p_run uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     jsonb;
  v_saved integer := 0;
begin
  if not exists (select 1 from public.match_run r where r.id = p_run and r.household_id = p_household and r.finished_at is null) then
    raise exception 'no such run' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p -> 'suggestions', '[]')) > 2000 or jsonb_array_length(coalesce(p -> 'usage', '[]')) > 500
     or jsonb_array_length(coalesce(p -> 'evals', '[]')) > 2000 then
    raise exception 'too much at once' using errcode = '23514';
  end if;

  for v_s in select value from jsonb_array_elements(coalesce(p -> 'suggestions', '[]')) loop
    insert into public.match_suggestion as m
      (household_id, task, target_key, line_id, sms_id, proposal, confidence, pattern, models, input_hash)
    values (p_household, v_s ->> 'task', v_s ->> 'target_key', (v_s ->> 'line_id')::uuid, (v_s ->> 'sms_id')::uuid,
            v_s -> 'proposal', (v_s ->> 'confidence')::numeric, v_s ->> 'pattern',
            coalesce(array(select jsonb_array_elements_text(v_s -> 'models')), '{}'), v_s ->> 'input_hash')
    on conflict (household_id, task, target_key) do update
      set proposal = excluded.proposal, confidence = excluded.confidence, pattern = excluded.pattern,
          models = excluded.models, input_hash = excluded.input_hash, line_id = excluded.line_id, sms_id = excluded.sms_id,
          status = 'pending', correction = null, decided_by = null, decided_at = null, updated_at = now()
      where m.status in ('pending', 'stale') or m.input_hash is distinct from excluded.input_hash;
    v_saved := v_saved + 1;
  end loop;

  update public.match_suggestion m set status = 'stale', updated_at = now()
    from jsonb_array_elements(coalesce(p -> 'stale', '[]')) x
   where m.household_id = p_household and m.status = 'pending'
     and m.task = x.value ->> 'task' and m.target_key = x.value ->> 'target_key';

  insert into public.ai_usage (household_id, run_id, provider, model, task, input_tokens, output_tokens, cost_usd, ok, error)
  select p_household, p_run, u ->> 'provider', u ->> 'model', u ->> 'task', coalesce((u ->> 'input_tokens')::integer, 0),
         coalesce((u ->> 'output_tokens')::integer, 0), coalesce((u ->> 'cost_usd')::numeric, 0), coalesce((u ->> 'ok')::boolean, false),
         left(u ->> 'error', 30)
    from jsonb_array_elements(coalesce(p -> 'usage', '[]')) u;

  insert into public.match_eval as e (household_id, task, target_key, truth, rule, ai, rule_correct, ai_correct)
  select p_household, x ->> 'task', x ->> 'target_key', x -> 'truth', x -> 'rule', x -> 'ai',
         (x ->> 'rule_correct')::boolean, (x ->> 'ai_correct')::boolean
    from jsonb_array_elements(coalesce(p -> 'evals', '[]')) x
  on conflict (household_id, task, target_key) do update
    set truth = excluded.truth, rule = excluded.rule, ai = excluded.ai, rule_correct = excluded.rule_correct,
        ai_correct = excluded.ai_correct, created_at = now();

  update public.match_run r set finished_at = now(), stats = coalesce(p -> 'stats', '{}')
   where r.id = p_run;
  return jsonb_build_object('suggestions', v_saved);
end;
$$;

-- ── Reports (security_invoker: members' RLS applies) ─────────────────────────
-- The accuracy test, per task: how much the rules / the AI answered, and how often they were right;
-- "sure" = AI confidence ≥ 0.9 (what 9c may book by itself).
create view public.v_match_accuracy
with (security_invoker = true) as
  select e.household_id, e.task, count(*)::integer as n,
         count(*) filter (where e.rule_correct is not null)::integer as rule_answered,
         count(*) filter (where e.rule_correct)::integer as rule_correct,
         count(*) filter (where e.ai_correct is not null)::integer as ai_answered,
         count(*) filter (where e.ai_correct)::integer as ai_correct,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9)::integer as sure_n,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9 and e.ai_correct)::integer as sure_correct,
         max(e.created_at) as tested_at
    from public.match_eval e
   group by e.household_id, e.task;

create view public.v_match_accuracy_pattern
with (security_invoker = true) as
  select e.household_id, e.task, coalesce(e.ai ->> 'pattern', 'rule') as pattern, count(*)::integer as n,
         count(*) filter (where coalesce(e.ai_correct, e.rule_correct))::integer as correct
    from public.match_eval e
   group by 1, 2, 3;

-- What people did with suggestions so far (the accuracy that counts in daily use).
create view public.v_match_decisions
with (security_invoker = true) as
  select s.household_id, s.task, s.pattern, count(*)::integer as n,
         count(*) filter (where s.status = 'accepted')::integer as accepted,
         count(*) filter (where s.status = 'changed')::integer as changed,
         count(*) filter (where s.status = 'rejected')::integer as rejected,
         count(*) filter (where s.status = 'pending')::integer as pending
    from public.match_suggestion s
   group by 1, 2, 3;

create view public.v_ai_cost_month
with (security_invoker = true) as
  select u.household_id, date_trunc('month', u.at)::date as month, u.provider, u.model,
         count(*)::integer as requests, count(*) filter (where not u.ok)::integer as failed,
         sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens,
         sum(u.cost_usd)::numeric(10,4) as cost_usd
    from public.ai_usage u
   group by 1, 2, 3, 4;

revoke all on public.v_match_accuracy, public.v_match_accuracy_pattern, public.v_match_decisions, public.v_ai_cost_month
  from anon, authenticated;
grant select on public.v_match_accuracy, public.v_match_accuracy_pattern, public.v_match_decisions, public.v_ai_cost_month
  to authenticated;

-- ── Privileges ────────────────────────────────────────────────────────────────
revoke execute on function public.rpc_match_settings_save(uuid, jsonb) from public, anon;
revoke execute on function public.rpc_match_decide(uuid[], text, jsonb) from public, anon;
revoke execute on function public.rpc_match_request(uuid, text) from public, anon;
grant execute on function public.rpc_match_settings_save(uuid, jsonb) to authenticated;
grant execute on function public.rpc_match_decide(uuid[], text, jsonb) to authenticated;
grant execute on function public.rpc_match_request(uuid, text) to authenticated;

revoke execute on function public.rpc_match_cron_begin(text) from public, anon, authenticated;
revoke execute on function public.rpc_match_bundle(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_match_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_match_cron_begin(text) to service_role;
grant execute on function public.rpc_match_bundle(uuid, uuid, text) to service_role;
grant execute on function public.rpc_match_save(uuid, uuid, jsonb) to service_role;

update public.app_meta set value = '80' where key = 'schema_version';
