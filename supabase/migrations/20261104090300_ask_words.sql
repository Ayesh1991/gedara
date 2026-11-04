-- Phase 10 · 101 — Ask Gedara: match by words (accuracy run 1 on prod, 2026-11-04: 35 of 50)
--
-- What the first accuracy run showed:
--   * a shop is written many ways (CARGILLS - KURANA, CARGILLS FOOD CITY - C …): "cargills" now covers every
--     shop name that contains all its words, not the one closest name;
--   * a shop name that contains the word ("CLAUDE.AI SUBSCRIPTION SAN FRANCISCO") beat the category
--     "Subscriptions": a category now wins over a product and a shop when they match as well;
--   * two categories matched equally ("Cocconut milk", "Dairy & milk"): the one with more spending wins;
--   * the AI's words are matched one by one ("rekha wuntakal mrcog book" finds "MRCOG part 2 Rekha wuntakal …");
--   * "show the bills" without a time looks back a year (was 30 days).
-- Same signatures and rules as migration 100 (invoker, stable, bounded, never valuables).

-- The words of `about` worth matching (lower case, 2+ characters, without filler words).
create function private.ask_words(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct w), '{}')
    from regexp_split_to_table(lower(coalesce(p_text, '')), '[\s,;:!?"()/]+') w
   where length(w) >= 2
     and w not in ('the', 'a', 'an', 'of', 'for', 'on', 'at', 'in', 'to', 'my', 'our', 'we', 'and', 'is', 'are',
                   'from', 'with', 'by', 'all', 'any');
$$;

-- How many of the words appear in the text (0 … 1).
create function private.ask_cover(p_words text[], p_text text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when cardinality(p_words) = 0 or p_text is null then 0
              else (select count(*) from unnest(p_words) w
                     where p_text ilike '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%')::numeric
                   / cardinality(p_words) end;
$$;

revoke execute on function private.ask_words(text) from public, anon;
revoke execute on function private.ask_cover(text[], text) from public, anon;
grant execute on function private.ask_words(text) to authenticated;
grant execute on function private.ask_cover(text[], text) to authenticated;

-- ── Spending: what "about" means ───────────────────────────────────────────────
create or replace function private.ask_match_spend(p_household uuid, p_about text, p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_about text := private.ask_check_about(p_about);
  v_words text[] := private.ask_words(v_about);
  v_since date := private.ask_today(p_household) - 1096;
  v_best  jsonb;
  v_also  jsonb;
begin
  if p_kind is not null then
    if p_kind not in ('category', 'sub', 'product', 'shop', 'words', 'all') then
      raise exception 'bad kind' using errcode = '22023';
    end if;
    if p_kind = 'all' then return jsonb_build_object('kind', 'all', 'also', '[]'::jsonb); end if;
    if p_kind in ('shop', 'words') then
      if v_about is null then raise exception 'about is required' using errcode = '22023'; end if;
      return jsonb_build_object('kind', p_kind, 'name', v_about, 'also', '[]'::jsonb);
    end if;
    select jsonb_build_object('kind', p_kind, 'id', x.id, 'name', x.name, 'also', '[]'::jsonb) into v_best
      from (select c.id, c.name from public.category c
             where p_kind in ('category', 'sub') and c.household_id = p_household and c.id = p_id
            union all
            select p.id, p.name from public.product p
             where p_kind = 'product' and p.household_id = p_household and p.id = p_id) x;
    if v_best is null then raise exception 'not found' using errcode = '22023'; end if;
    return v_best;
  end if;

  if v_about is null then return jsonb_build_object('kind', 'all', 'also', '[]'::jsonb); end if;

  with lines as (
    select v.category_id, v.top_category_id, v.product_id, v.merchant_name
      from public.v_spend_line v
     where v.household_id = p_household and v.occurred_on >= v_since
  ),
  cand as (
    select case when c.parent_id is null then 'category' else 'sub' end as kind, c.id, c.name,
           private.ask_cover(v_words, c.name) as cover, extensions.word_similarity(v_about, c.name) as sim,
           case when c.parent_id is null then 5 else 4 end as pri,
           (select count(*) from lines l where (c.parent_id is null and l.top_category_id = c.id) or l.category_id = c.id) as n
      from public.category c
     where c.household_id = p_household and not c.archived and c.kind in ('expense', 'both')
    union all
    select 'product', p.id, p.name,
           greatest(private.ask_cover(v_words, p.name), private.ask_cover(v_words, p.name_si)),
           greatest(extensions.word_similarity(v_about, p.name), extensions.word_similarity(v_about, coalesce(p.name_si, ''))),
           3, (select count(*) from lines l where l.product_id = p.id)
      from public.product p
     where p.household_id = p_household and not p.archived and p.merged_into_id is null
    union all
    -- one shop candidate for all the names that contain every word ("cargills" → every Cargills)
    select 'shop', null::uuid, v_about, 1, 1, 2, count(*)
      from lines l
     where l.merchant_name is not null and private.ask_cover(v_words, l.merchant_name) = 1
    having count(*) > 0
  ),
  ranked as (
    select c.*, row_number() over (order by (c.cover = 1) desc, (c.n > 0) desc, c.pri desc, c.n desc, c.cover desc, c.sim desc, c.name) as r
      from cand c
     where c.cover >= 0.5 or c.sim >= 0.6
  )
  select (select jsonb_build_object('kind', r.kind, 'id', r.id, 'name', r.name) from ranked r where r.r = 1),
         (select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'id', r.id, 'name', r.name) order by r.r), '[]')
            from ranked r where r.r between 2 and 5)
    into v_best, v_also;

  if v_best is null then
    return jsonb_build_object('kind', 'words', 'name', v_about, 'also', '[]'::jsonb);
  end if;
  return v_best || jsonb_build_object('also', v_also || jsonb_build_array(jsonb_build_object('kind', 'words', 'name', v_about)));
end;
$$;

-- A shop or words: every word must appear (in the shop's name / on the bill line or its product).
create or replace function private.ask_spend_lines(p_household uuid, p_match jsonb, p_from date, p_to date)
returns setof public.v_spend_line
language sql
stable
set search_path = ''
as $$
  select v.* from public.v_spend_line v
   where v.household_id = p_household and v.occurred_on between p_from and p_to
     and case p_match ->> 'kind'
           when 'all' then true
           when 'category' then v.top_category_id = (p_match ->> 'id')::uuid
           when 'sub' then v.category_id = (p_match ->> 'id')::uuid
           when 'product' then v.product_id = (p_match ->> 'id')::uuid
           when 'shop' then private.ask_cover(private.ask_words(p_match ->> 'name'), v.merchant_name) = 1
           when 'words' then greatest(private.ask_cover(private.ask_words(p_match ->> 'name'), v.raw_name),
                                      private.ask_cover(private.ask_words(p_match ->> 'name'), v.product_name)) = 1
           else false
         end;
$$;

-- ── Bills behind a total: a year back when no time is given ────────────────────
create or replace function public.ask_transactions(p_household uuid, p_about text default null, p_from date default null,
                                                   p_to date default null, p_limit integer default 5,
                                                   p_kind text default null, p_id uuid default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_from  date;
  v_to    date;
  v_match jsonb;
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  v_to := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_to - 365);
  perform private.ask_check_range(v_from, v_to, v_today);
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception 'limit is 1 to 10' using errcode = '22023';
  end if;
  v_match := private.ask_match_spend(p_household, p_about, p_kind, p_id);

  with t as (
    select l.transaction_id as id, min(l.occurred_on) as on_date, min(l.merchant_name) as payee,
           min(l.account_name) as account, sum(l.amount) as amount
      from private.ask_spend_lines(p_household, v_match, v_from, v_to) l
     group by l.transaction_id
  )
  select jsonb_build_object(
           'from', v_from, 'to', v_to, 'today', v_today, 'match', v_match,
           'count', (select count(*) from t), 'total', (select coalesce(sum(amount), 0) from t),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'date', r.on_date, 'payee', r.payee,
                                                                 'account', r.account, 'amount', r.amount)
                                              order by r.on_date desc, r.amount desc)
                              from (select * from t order by on_date desc, amount desc limit p_limit) r), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;

-- ── Instalments: by words of the plan, its account or bank ─────────────────────
create or replace function public.ask_instalments(p_household uuid, p_about text default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_words text[] := private.ask_words(v_about);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;

  with plans as (
    select p.*, a.name as account_name,
           (select count(*)::integer from generate_series(1, p.total_count) n
             where private.instalment_date(p.first_on, n) <= v_today) as paid,
           case when v_about is null then 1
                else private.ask_cover(v_words, p.name || ' ' || a.name || ' ' || coalesce(a.institution, '') || ' ' || p.kind
                                                || ' ' || coalesce(p.notes, ''))
                     + extensions.word_similarity(v_about, p.name) / 10 end as score
      from public.instalment_plan p
      join public.account a on a.id = p.account_id and a.household_id = p.household_id
     where p.household_id = p_household and not p.archived
  ),
  hits as (
    select pl.*, pl.total_count - pl.paid as left_count,
           private.instalment_date(pl.first_on, pl.total_count) as last_on,
           case when pl.paid < pl.total_count then private.instalment_date(pl.first_on, pl.paid + 1) end as next_on,
           case when pl.kind = 'loan' and pl.principal is not null and pl.annual_rate is not null then
             round(greatest(0, case when pl.annual_rate = 0 then pl.principal - pl.monthly * pl.paid
                                    else pl.principal * power(1 + pl.annual_rate / 1200, pl.paid)
                                         - pl.monthly * (power(1 + pl.annual_rate / 1200, pl.paid) - 1) / (pl.annual_rate / 1200) end), 2)
           end as owed
      from plans pl
     where pl.score >= case when v_about is null then 0 else 0.5 end
       and (v_about is not null or pl.paid < pl.total_count)
     order by pl.score desc, private.instalment_date(pl.first_on, pl.total_count)
     limit 10
  )
  select jsonb_build_object(
           'today', v_today, 'about', v_about,
           'monthly_total', (select coalesce(sum(h.monthly), 0) from hits h where h.left_count > 0),
           'rows', coalesce(jsonb_agg(jsonb_build_object(
                      'id', h.id, 'name', h.name, 'kind', h.kind, 'account', h.account_name, 'monthly', h.monthly,
                      'total_count', h.total_count, 'paid', h.paid, 'left', h.left_count, 'next_on', h.next_on,
                      'last_on', h.last_on, 'left_to_pay', round(h.left_count * h.monthly, 2), 'owed', h.owed)
                    order by h.score desc, h.last_on), '[]'::jsonb))
    into v_out
    from hits h;
  return v_out;
end;
$$;

-- ── Where is it? By words (never valuables) ────────────────────────────────────
create or replace function public.ask_find(p_household uuid, p_about text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_words text[];
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  if v_about is null then raise exception 'about is required' using errcode = '22023'; end if;
  v_words := private.ask_words(v_about);

  with cand as (
    select 'thing'::text as kind, a.id, a.name,
           private.ask_cover(v_words, a.name || ' ' || coalesce(a.manufacturer, '') || ' ' || coalesce(a.model_no, '')) as cover,
           extensions.word_similarity(v_about, a.name) as sim,
           l.id as place_id, l.path as place, a.status, a.lent_to, null::numeric as qty, null::text as unit
      from public.asset a
      left join public.location l on l.id = a.location_id and l.household_id = a.household_id
     where a.household_id = p_household and not a.archived and not a.valuable
       and not coalesce(l.in_valuable, false)
       and a.status not in ('sold', 'disposed', 'lost')
    union all
    select 'product', p.id, p.name,
           greatest(private.ask_cover(v_words, p.name), private.ask_cover(v_words, p.name_si)),
           greatest(extensions.word_similarity(v_about, p.name), extensions.word_similarity(v_about, coalesce(p.name_si, ''))),
           st.place_id, st.place, null, null, st.qty, u.code
      from public.product p
      left join public.unit u on u.id = p.stock_unit_id
      left join lateral (
        select sum(s.qty_remaining) as qty,
               (array_agg(l.id order by s.qty_remaining desc))[1] as place_id,
               (array_agg(l.path order by s.qty_remaining desc))[1] as place
          from public.stock_lot s
          left join public.location l on l.id = s.location_id and l.household_id = s.household_id
         where s.household_id = p.household_id and s.product_id = p.id and s.qty_remaining > 0
           and not coalesce(l.in_valuable, false)
      ) st on true
     where p.household_id = p_household and not p.archived and p.merged_into_id is null
    union all
    select 'place', l.id, l.name, private.ask_cover(v_words, l.path), extensions.word_similarity(v_about, l.path),
           l.id, l.path, null, null, null, null
      from public.location l
     where l.household_id = p_household and not l.in_valuable
  ),
  ranked as (
    select c.*, row_number() over (order by c.cover desc, (c.qty > 0) desc nulls last, c.sim desc, c.name) as n
      from cand c where c.cover >= 0.5 or c.sim >= 0.6
  )
  select jsonb_build_object('about', v_about,
           'rows', coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'id', r.id, 'name', r.name, 'place_id', r.place_id,
                                                         'place', r.place, 'status', r.status, 'lent_to', r.lent_to,
                                                         'qty', r.qty, 'unit', r.unit) order by r.n), '[]'::jsonb))
    into v_out
    from ranked r where r.n <= 5;
  return v_out;
end;
$$;

-- ── Balances: by words of the account (name, bank, kind, last digits) ─────────
create or replace function public.ask_balances(p_household uuid, p_about text default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_words text[] := private.ask_words(v_about);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;

  with acc as (
    select a.id, a.name, a.kind, a.institution, a.last4, b.balance, b.available, b.last_on, a.credit_limit,
           case when v_about is null then 1
                else private.ask_cover(v_words, a.name || ' ' || coalesce(a.institution, '') || ' ' || replace(a.kind, '_', ' ')
                                                || case a.kind when 'credit_card' then ' card' when 'bank' then ' account' else '' end
                                                || ' ' || coalesce(a.last4, ''))
                     + extensions.word_similarity(v_about, a.name) / 10 end as score
      from public.account a
      join public.v_account_balance b on b.account_id = a.id and b.household_id = a.household_id
     where a.household_id = p_household and not a.archived and not a.is_suspense
  ),
  hits as (
    select * from acc where score >= case when v_about is null then 0 else 0.5 end
     order by score desc, name limit 10
  )
  select jsonb_build_object('today', v_today, 'about', v_about,
           'rows', coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'kind', h.kind, 'institution', h.institution,
                                                         'last4', h.last4, 'balance', h.balance, 'available', h.available,
                                                         'credit_limit', h.credit_limit, 'last_on', h.last_on)
                                      order by h.score desc, h.name), '[]'::jsonb))
    into v_out
    from hits h;
  return v_out;
end;
$$;

update public.app_meta set value = '101' where key = 'schema_version';
