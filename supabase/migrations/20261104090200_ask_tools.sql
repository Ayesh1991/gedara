-- Phase 10 · 100 — Ask Gedara's fixed list of read-only questions (MASTER_PLAN §7 item 4)
--
-- The AI never sees any of this: it only turns words into a plan ("ask_spend · about fish · from
-- 2026-06-01"); the browser runs these functions with the asker's own login and fills a fixed sentence.
-- Rules for every ask_* function:
--   * SECURITY INVOKER (the caller's RLS; viewers too), stable, search_path '', authenticated only;
--   * null when the household isn't the caller's (cross-household test);
--   * bounded: dates 2020-01-01 … today + 400 days and ≤ 3 years apart, ≤ 10 rows, `about` ≤ 60 chars;
--   * only the fields the sentence needs, plus ids for links to Gedara's own pages;
--   * never valuables (valuable things, anything in a valuable place) — not even for the owner;
--   * never SMS, the house, devices, tokens, e-mails, scans, attachments or activity.

-- ── Helpers (invoker; pure checks) ─────────────────────────────────────────────

create function private.ask_today(p_household uuid)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone h.timezone)::date from public.household h where h.id = p_household;
$$;

create function private.ask_check_range(p_from date, p_to date, p_today date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from < date '2020-01-01' or p_to > p_today + 400
     or p_from > p_to or p_to - p_from > 1096 then
    raise exception 'dates out of range' using errcode = '22023';
  end if;
end;
$$;

create function private.ask_check_about(p_about text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_about is not null and length(p_about) > 60 then
    raise exception 'about is too long' using errcode = '22023';
  end if;
  return nullif(btrim(p_about), '');
end;
$$;

-- Instalment n (1-based) of a plan whose first fell on p_first: same day of each month, or the
-- month's last day (same as instalmentDate in apps/web/src/lib/money/instalments.ts).
create function private.instalment_date(p_first date, p_n integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select m + (least(extract(day from p_first)::integer,
                    extract(day from (m + interval '1 month - 1 day'))::integer) - 1)
    from (select (date_trunc('month', p_first) + make_interval(months => p_n - 1))::date as m) x;
$$;

-- What spending "about" means: a category, a sub-category, a product, a shop, or words on bill lines.
-- p_kind/p_id (or p_kind 'shop' + exact name) re-run a choice the person tapped, without the AI.
-- Returns { kind, id, name, also: [{kind, id, name}] } — kind 'all' when there's nothing to match.
create function private.ask_match_spend(p_household uuid, p_about text, p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_about text := private.ask_check_about(p_about);
  v_pat   text;
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
  v_pat := '%' || replace(replace(replace(v_about, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with cand as (
    select case when c.parent_id is null then 'category' else 'sub' end as kind, c.id, c.name,
           (case when c.name ilike v_pat then 1 else 0 end + extensions.word_similarity(v_about, c.name)) as score,
           case when c.parent_id is null then 5 else 4 end as pri
      from public.category c
     where c.household_id = p_household and not c.archived and c.kind in ('expense', 'both')
    union all
    select 'product', p.id, p.name,
           (case when p.name ilike v_pat or coalesce(p.name_si, '') ilike v_pat then 1 else 0 end
            + greatest(extensions.word_similarity(v_about, p.name), extensions.word_similarity(v_about, coalesce(p.name_si, '')))),
           3
      from public.product p
     where p.household_id = p_household and not p.archived and p.merged_into_id is null
    union all
    select 'shop', null::uuid, s.merchant_name,
           (case when s.merchant_name ilike v_pat then 1 else 0 end + extensions.word_similarity(v_about, s.merchant_name)),
           2
      from (select distinct v.merchant_name from public.v_spend_line v
             where v.household_id = p_household and v.merchant_name is not null
               and v.occurred_on >= private.ask_today(p_household) - 1096) s
  ),
  ranked as (
    select c.*, row_number() over (order by c.score desc, c.pri desc, c.name) as n
      from cand c where c.score >= 0.6
  )
  select (select jsonb_build_object('kind', r.kind, 'id', r.id, 'name', r.name) from ranked r where r.n = 1),
         (select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'id', r.id, 'name', r.name) order by r.n), '[]')
            from ranked r where r.n between 2 and 5)
    into v_best, v_also;

  if v_best is null then
    -- Nothing by name: words printed on bill lines ("fish" in "FISH SALAYA 500G").
    return jsonb_build_object('kind', 'words', 'name', v_about, 'also', '[]'::jsonb);
  end if;
  return v_best || jsonb_build_object('also', v_also || jsonb_build_array(jsonb_build_object('kind', 'words', 'name', v_about)));
end;
$$;

-- The spend lines a match covers.
create function private.ask_spend_lines(p_household uuid, p_match jsonb, p_from date, p_to date)
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
           when 'shop' then v.merchant_name = p_match ->> 'name'
           when 'words' then v.raw_name ilike '%' || replace(replace(replace(p_match ->> 'name', '\', '\\'), '%', '\%'), '_', '\_') || '%'
                          or coalesce(v.product_name, '') ilike '%' || replace(replace(replace(p_match ->> 'name', '\', '\\'), '%', '\%'), '_', '\_') || '%'
           else false
         end;
$$;

-- ── 1. Spending ────────────────────────────────────────────────────────────────
-- p_group: null | category | shop | month | account | product → top 5 groups.
create function public.ask_spend(p_household uuid, p_about text default null, p_from date default null,
                                 p_to date default null, p_group text default null,
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
  v_from := coalesce(p_from, date_trunc('month', v_today)::date);
  v_to := coalesce(p_to, v_today);
  perform private.ask_check_range(v_from, v_to, v_today);
  if p_group is not null and p_group not in ('category', 'shop', 'month', 'account', 'product') then
    raise exception 'bad group' using errcode = '22023';
  end if;
  v_match := private.ask_match_spend(p_household, p_about, p_kind, p_id);

  select jsonb_build_object(
           'from', v_from, 'to', v_to, 'today', v_today, 'match', v_match,
           'total', coalesce(sum(l.amount), 0), 'lines', count(*), 'bills', count(distinct l.transaction_id),
           'groups', case when p_group is null then '[]'::jsonb else coalesce((
             select jsonb_agg(g order by (g ->> 'total')::numeric desc) from (
               select jsonb_build_object('name', x.name, 'id', x.id, 'total', sum(x.amount), 'bills', count(distinct x.transaction_id)) as g
                 from (select case p_group when 'category' then coalesce(s.category_name, '—')
                                           when 'shop' then coalesce(s.merchant_name, '—')
                                           when 'month' then to_char(s.month, 'YYYY-MM')
                                           when 'account' then s.account_name
                                           else coalesce(s.product_name, '—') end as name,
                              case p_group when 'category' then s.category_id when 'account' then s.account_id
                                           when 'product' then s.product_id end as id,
                              s.amount, s.transaction_id
                         from private.ask_spend_lines(p_household, v_match, v_from, v_to) s) x
                group by x.name, x.id
                order by sum(x.amount) desc
                limit 5) y), '[]'::jsonb) end)
    into v_out
    from private.ask_spend_lines(p_household, v_match, v_from, v_to) l;
  return v_out;
end;
$$;

-- ── 2. Transactions (the bills behind a total) ─────────────────────────────────
create function public.ask_transactions(p_household uuid, p_about text default null, p_from date default null,
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
  v_from := coalesce(p_from, v_today - 30);
  v_to := coalesce(p_to, v_today);
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

-- ── 3. What's due (recurring bills + instalments) ──────────────────────────────
create function public.ask_due(p_household uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_from  date;
  v_to    date;
  v_rows  jsonb;
begin
  if v_today is null then return null; end if;
  v_from := coalesce(p_from, v_today);
  v_to := coalesce(p_to, (date_trunc('month', v_today) + interval '1 month - 1 day')::date);
  perform private.ask_check_range(v_from, v_to, v_today);

  -- A recurring bill: its next unpaid date and every later one up to v_to (an unpaid one before
  -- v_from and before today is shown as overdue).
  with recursive occ as (
    select r.id, r.name, r.first_due, r.every_n, r.every_unit, coalesce(r.expected_amount, r.last_amount) as amount,
           r.account_name, r.next_due as on_date, 1 as k
      from public.v_recurring_due r
     where r.household_id = p_household and r.active and r.next_due <= v_to
    union all
    select o.id, o.name, o.first_due, o.every_n, o.every_unit, o.amount, o.account_name,
           private.recurring_next(o.first_due, o.every_n, o.every_unit, o.on_date), o.k + 1
      from occ o
     where o.k < 40 and o.on_date <= v_to
  ),
  items as (
    select 'bill'::text as kind, o.id, o.name, o.on_date, o.amount, o.account_name as account,
           (o.on_date < least(v_from, v_today)) as overdue
      from occ o
     where o.on_date <= v_to and (o.on_date >= v_from or (o.k = 1 and o.on_date < v_today and v_from <= v_today))
    union all
    select 'instalment', p.id, p.name, d.on_date, p.monthly, a.name, false
      from public.instalment_plan p
      join public.account a on a.id = p.account_id and a.household_id = p.household_id
      cross join lateral generate_series(1, p.total_count) n
      cross join lateral (select private.instalment_date(p.first_on, n) as on_date) d
     where p.household_id = p_household and not p.archived and d.on_date between v_from and v_to
  ),
  firsts as (
    select * from items order by on_date, name limit 10
  )
  select jsonb_build_object(
           'from', v_from, 'to', v_to, 'today', v_today,
           'count', (select count(*) from items), 'total', (select coalesce(sum(amount), 0) from items),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('kind', f.kind, 'id', f.id, 'name', f.name, 'date', f.on_date,
                                                                 'amount', f.amount, 'account', f.account, 'overdue', f.overdue)
                                              order by f.on_date, f.name) from firsts f), '[]'::jsonb))
    into v_rows;
  return v_rows;
end;
$$;

-- ── 4. Instalment plans and loans ──────────────────────────────────────────────
create function public.ask_instalments(p_household uuid, p_about text default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;

  with plans as (
    select p.*, a.name as account_name, a.institution,
           (select count(*)::integer from generate_series(1, p.total_count) n
             where private.instalment_date(p.first_on, n) <= v_today) as paid,
           case when v_about is null then 1
                else (case when (p.name || ' ' || a.name || ' ' || coalesce(a.institution, '')) ilike '%' || v_about || '%' then 1 else 0 end)
                     + extensions.word_similarity(v_about, p.name || ' ' || a.name || ' ' || coalesce(a.institution, '')) end as score
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

-- ── 5. Where is it? (things, products, places — never valuables) ───────────────
create function public.ask_find(p_household uuid, p_about text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_pat   text;
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  if v_about is null then raise exception 'about is required' using errcode = '22023'; end if;
  v_pat := '%' || replace(replace(replace(v_about, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with cand as (
    select 'thing'::text as kind, a.id, a.name,
           (case when a.name ilike v_pat then 1 else 0 end + extensions.word_similarity(v_about, a.name)) as score,
           l.id as place_id, l.path as place, a.status, a.lent_to, null::numeric as qty, null::text as unit
      from public.asset a
      left join public.location l on l.id = a.location_id and l.household_id = a.household_id
     where a.household_id = p_household and not a.archived and not a.valuable
       and not coalesce(l.in_valuable, false)
       and a.status not in ('sold', 'disposed', 'lost')
    union all
    select 'product', p.id, p.name,
           (case when p.name ilike v_pat or coalesce(p.name_si, '') ilike v_pat then 1 else 0 end
            + greatest(extensions.word_similarity(v_about, p.name), extensions.word_similarity(v_about, coalesce(p.name_si, '')))),
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
    select 'place', l.id, l.name,
           (case when l.path ilike v_pat then 1 else 0 end + extensions.word_similarity(v_about, l.path)),
           l.id, l.path, null, null, null, null
      from public.location l
     where l.household_id = p_household and not l.in_valuable
  ),
  ranked as (
    select c.*, row_number() over (order by c.score desc, c.name) as n from cand c where c.score >= 0.6
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

-- ── 6. Pantry: running out, expiring, below minimum ────────────────────────────
create function public.ask_pantry(p_household uuid, p_view text, p_within_days integer default 7)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  if p_view is null or p_view not in ('runout', 'expiring', 'below_min') then
    raise exception 'bad view' using errcode = '22023';
  end if;
  if p_within_days is null or p_within_days not between 1 and 60 then
    raise exception 'within_days is 1 to 60' using errcode = '22023';
  end if;

  if p_view = 'runout' then
    select jsonb_build_object('view', p_view, 'within_days', p_within_days, 'today', v_today,
             'rows', coalesce(jsonb_agg(jsonb_build_object('id', x.product_id, 'name', x.product_name, 'days', x.days_to_empty,
                                                           'qty', x.qty, 'unit', x.unit_code) order by x.days_to_empty, x.product_name), '[]'::jsonb))
      into v_out
      from (select v.* from public.v_product_velocity v
              join public.product p on p.id = v.product_id and p.household_id = v.household_id
             where v.household_id = p_household and not p.archived and v.days_to_empty is not null
               and v.days_to_empty <= p_within_days
             order by v.days_to_empty, v.product_name limit 10) x;
  elsif p_view = 'expiring' then
    select jsonb_build_object('view', p_view, 'within_days', p_within_days, 'today', v_today,
             'rows', coalesce(jsonb_agg(jsonb_build_object('id', x.product_id, 'name', x.name, 'date', x.due_date,
                                                           'due_type', x.due_type, 'qty', x.qty_remaining, 'unit', x.code,
                                                           'place', x.path) order by x.due_date, x.name), '[]'::jsonb))
      into v_out
      from (select s.product_id, p.name, s.due_date, p.due_type, s.qty_remaining, u.code, l.path
              from public.stock_lot s
              join public.product p on p.id = s.product_id and p.household_id = s.household_id
              left join public.unit u on u.id = p.stock_unit_id
              left join public.location l on l.id = s.location_id and l.household_id = s.household_id
             where s.household_id = p_household and s.qty_remaining > 0 and s.due_date is not null
               and s.due_date <= v_today + p_within_days and not coalesce(l.in_valuable, false)
             order by s.due_date, p.name limit 10) x;
  else
    select jsonb_build_object('view', p_view, 'today', v_today,
             'rows', coalesce(jsonb_agg(jsonb_build_object('id', x.product_id, 'name', x.product_name, 'qty', x.qty,
                                                           'min', x.min_qty, 'unit', x.unit_code) order by x.product_name), '[]'::jsonb))
      into v_out
      from (select v.* from public.v_product_velocity v
              join public.product p on p.id = v.product_id and p.household_id = v.household_id
             where v.household_id = p_household and not p.archived and v.below_min
             order by v.product_name limit 10) x;
  end if;
  return v_out;
end;
$$;

-- ── 7. Balances (account name and last 4 digits at most) ───────────────────────
create function public.ask_balances(p_household uuid, p_about text default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_about text := private.ask_check_about(p_about);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;

  with acc as (
    select a.id, a.name, a.kind, a.institution, a.last4, b.balance, b.available, b.last_on, a.credit_limit,
           case when v_about is null then 1
                else (case when (a.name || ' ' || coalesce(a.institution, '') || ' ' || a.kind || ' ' || coalesce(a.last4, ''))
                                ilike '%' || v_about || '%' then 1 else 0 end)
                     + extensions.word_similarity(v_about, a.name || ' ' || coalesce(a.institution, '') || ' ' || replace(a.kind, '_', ' '))
           end as score
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

-- ── 8. Budget vs spent for a month ─────────────────────────────────────────────
create function public.ask_budget(p_household uuid, p_month date default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_month date;
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  v_month := date_trunc('month', coalesce(p_month, v_today))::date;
  perform private.ask_check_range(v_month, v_month, v_today);

  select jsonb_build_object('month', v_month, 'today', v_today,
           'rows', coalesce(jsonb_agg(jsonb_build_object('id', b.category_id, 'name', b.name, 'budget', b.budget,
                                                         'spent', b.spent, 'left', b.budget - b.spent)
                                      order by (b.budget - b.spent) nulls last, b.name), '[]'::jsonb))
    into v_out
    from (select * from public.budget_month(p_household, v_month) where budget is not null
           order by (budget - spent), name limit 10) b;
  return v_out;
end;
$$;

-- ── 9. Warranties ending (never valuables) ─────────────────────────────────────
create function public.ask_warranty(p_household uuid, p_within_days integer default 60)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date := private.ask_today(p_household);
  v_out   jsonb;
begin
  if v_today is null then return null; end if;
  if p_within_days is null or p_within_days not between 1 and 400 then
    raise exception 'within_days is 1 to 400' using errcode = '22023';
  end if;

  select jsonb_build_object('within_days', p_within_days, 'today', v_today,
           'rows', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'date', x.warranty_until,
                                                         'days', x.warranty_until - v_today) order by x.warranty_until, x.name), '[]'::jsonb))
    into v_out
    from (select a.id, a.name, a.warranty_until
            from public.asset a
            left join public.location l on l.id = a.location_id and l.household_id = a.household_id
           where a.household_id = p_household and not a.archived and not a.valuable and not coalesce(l.in_valuable, false)
             and a.status not in ('sold', 'disposed', 'lost') and not coalesce(a.lifetime_warranty, false)
             and a.warranty_until between v_today and v_today + p_within_days
           order by a.warranty_until, a.name limit 10) x;
  return v_out;
end;
$$;

-- ── Grants: authenticated only ─────────────────────────────────────────────────
revoke execute on function private.ask_today(uuid) from public, anon;
revoke execute on function private.ask_check_range(date, date, date) from public, anon;
revoke execute on function private.ask_check_about(text) from public, anon;
revoke execute on function private.instalment_date(date, integer) from public, anon;
revoke execute on function private.ask_match_spend(uuid, text, text, uuid) from public, anon;
revoke execute on function private.ask_spend_lines(uuid, jsonb, date, date) from public, anon;
grant execute on function private.ask_today(uuid) to authenticated;
grant execute on function private.ask_check_range(date, date, date) to authenticated;
grant execute on function private.ask_check_about(text) to authenticated;
grant execute on function private.instalment_date(date, integer) to authenticated;
grant execute on function private.ask_match_spend(uuid, text, text, uuid) to authenticated;
grant execute on function private.ask_spend_lines(uuid, jsonb, date, date) to authenticated;

revoke execute on function public.ask_spend(uuid, text, date, date, text, text, uuid) from public, anon;
revoke execute on function public.ask_transactions(uuid, text, date, date, integer, text, uuid) from public, anon;
revoke execute on function public.ask_due(uuid, date, date) from public, anon;
revoke execute on function public.ask_instalments(uuid, text) from public, anon;
revoke execute on function public.ask_find(uuid, text) from public, anon;
revoke execute on function public.ask_pantry(uuid, text, integer) from public, anon;
revoke execute on function public.ask_balances(uuid, text) from public, anon;
revoke execute on function public.ask_budget(uuid, date) from public, anon;
revoke execute on function public.ask_warranty(uuid, integer) from public, anon;
grant execute on function public.ask_spend(uuid, text, date, date, text, text, uuid) to authenticated;
grant execute on function public.ask_transactions(uuid, text, date, date, integer, text, uuid) to authenticated;
grant execute on function public.ask_due(uuid, date, date) to authenticated;
grant execute on function public.ask_instalments(uuid, text) to authenticated;
grant execute on function public.ask_find(uuid, text) to authenticated;
grant execute on function public.ask_pantry(uuid, text, integer) to authenticated;
grant execute on function public.ask_balances(uuid, text) to authenticated;
grant execute on function public.ask_budget(uuid, date) to authenticated;
grant execute on function public.ask_warranty(uuid, integer) to authenticated;

update public.app_meta set value = '100' where key = 'schema_version';
