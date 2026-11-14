-- v0.13.0 · 115 — "Used" for things, and live photos for photo-by-scan
--
-- Used (Didula's choice 2026-11-15): a small thing used up in building something else. It leaves the
-- active list like sold / disposed / lost, keeps the day (gone_on) and an optional note on what it
-- went into (gone_note), is worth 0 from that day, and can be brought back (in use again; both
-- fields cleared). Disposed = it left the house; Used = it is part of something we still have.
-- gone_on / gone_note may also be set for disposed / lost; every active or sold status clears them.
--
-- Every hand-written "gone" list gains 'used': v_asset (value 0, months owned end at gone_on),
-- v_location_contents, attention_items (no warranty / service alerts), Ask's ask_find / ask_warranty.
--
-- Photo by scan: attachment joins the Realtime publication, so a thing / product page open on the
-- PC shows the photo the phone just saved (Realtime applies the select policy: a valuable thing's
-- photos never reach anyone but the owner). No polling.

alter table public.asset drop constraint asset_status_check;
alter table public.asset
  add constraint asset_status_check
    check (status in ('in_use', 'stored', 'lent', 'in_repair', 'sold', 'disposed', 'lost', 'used')),
  add column gone_on   date,
  add column gone_note text check (length(gone_note) <= 200);

grant insert (gone_on, gone_note) on table public.asset to authenticated;
grant update (gone_on, gone_note) on table public.asset to authenticated;

-- Runs after asset_check (triggers fire by name).
create function private.asset_gone_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_today date;
begin
  new.gone_note := nullif(btrim(new.gone_note), '');
  if new.status in ('used', 'disposed', 'lost') then
    select (now() at time zone h.timezone)::date into v_today from public.household h where h.id = new.household_id;
    v_today := coalesce(v_today, current_date);
    if new.status = 'used' then
      new.gone_on := coalesce(new.gone_on, v_today);
    end if;
    if new.gone_on > v_today then
      raise exception 'that day is still to come' using errcode = 'GDGON';
    end if;
    if new.gone_on < new.purchased_on then
      raise exception 'that day is before it was bought' using errcode = 'GDGON';
    end if;
  else
    new.gone_on := null;
    new.gone_note := null;
  end if;
  return new;
end;
$$;

create trigger asset_gone_check
  before insert or update on public.asset
  for each row execute function private.asset_gone_check();

-- History: used {gone_on, note} · unused (brought back). Everything else as before (migration 36).
create or replace function private.asset_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_to   text;
begin
  if tg_op = 'INSERT' then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id, 'created', new.name,
            jsonb_build_object('location_id', new.location_id, 'from_bill', new.transaction_line_id is not null));
    return null;
  end if;

  if new.location_id is distinct from old.location_id then
    select l.path into v_from from public.location l where l.id = old.location_id;
    select l.path into v_to from public.location l where l.id = new.location_id;
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id, 'moved', left(coalesce(v_to, '—'), 200),
            jsonb_build_object('from', old.location_id, 'to', new.location_id, 'from_path', v_from, 'to_path', v_to));
  end if;

  if new.status is distinct from old.status then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id,
            case
              when new.status = 'sold' then 'sold'
              when old.status = 'sold' then 'unsold'
              when new.status = 'used' then 'used'
              when old.status = 'used' then 'unused'
              when new.status = 'lent' then 'lent'
              when old.status = 'lent' then 'returned'
              else 'status'
            end,
            case
              when new.status = 'sold' then new.sold_to
              when new.status = 'used' then new.gone_note
              when new.status = 'lent' then new.lent_to
              when old.status = 'lent' then old.lent_to
            end,
            jsonb_build_object('from', old.status, 'to', new.status)
              || case when new.status = 'lent' then jsonb_build_object('lent_to', new.lent_to) else '{}'::jsonb end
              || case when old.status = 'lent' then jsonb_build_object('lent_to', old.lent_to, 'lent_on', old.lent_on) else '{}'::jsonb end
              || case when new.status = 'sold' then jsonb_build_object('price', new.sold_price, 'sold_to', new.sold_to) else '{}'::jsonb end
              || case when new.status = 'used' then jsonb_build_object('gone_on', new.gone_on, 'note', new.gone_note) else '{}'::jsonb end
              || case when old.status = 'used' then jsonb_build_object('gone_on', old.gone_on, 'note', old.gone_note) else '{}'::jsonb end);
  end if;
  return null;
end;
$$;

-- ── Gone lists ────────────────────────────────────────────────────────────────
create or replace view public.v_asset
with (security_invoker = true) as
  select a.id, a.household_id, a.asset_no, a.code, a.name, a.description, a.category_id,
         coalesce(a.location_id, pp.location_id) as location_id,
         a.parent_id, a.quantity, a.manufacturer, a.model_no, a.serial_no, a.condition, a.status,
         a.lent_to, a.lent_on, a.transaction_line_id, a.purchase_price, a.purchased_on, a.vendor,
         a.useful_life_months, a.salvage_value, a.warranty_until, a.lifetime_warranty, a.warranty_notes,
         a.insured, a.insurance_notes, a.sold_on, a.sold_to, a.sold_price, a.sale_transaction_id, a.custom,
         a.archived, a.created_by, a.created_at, a.updated_at,
         'A-' || lpad(a.asset_no::text, 4, '0') as tag,
         c.name as category_name,
         c.parent_id as category_parent_id,
         pc.name as category_parent_name,
         l.path as location_path,
         pa.name as parent_name,
         pa.asset_no as parent_asset_no,
         coalesce(ch.parts, 0) as parts,
         coalesce(tg.tag_ids, '{}') as tag_ids,
         coalesce(tg.tag_names, '{}') as tag_names,
         tl.transaction_id as bill_id,
         bt.occurred_on as bill_date,
         bt.payee_text as bill_payee,
         d.today,
         d.months_owned,
         v.book_value,
         case when a.status in ('sold', 'disposed', 'lost', 'used') then 0 else v.book_value end as current_value,
         coalesce(mt.maintenance_cost, 0) as maintenance_cost,
         mt.last_maintained_on,
         case when a.purchase_price is null then null
              else a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0) end
           as cost_of_ownership,
         case when a.purchase_price is null or d.months_owned is null then null
              else round((a.purchase_price + coalesce(mt.maintenance_cost, 0) - coalesce(a.sold_price, 0))
                         / greatest(d.months_owned, 1), 2) end
           as cost_per_month,
         case when a.status = 'sold' and a.sold_price is not null and v.book_value is not null
              then a.sold_price - v.book_value end as sale_gain,
         case when a.lifetime_warranty or a.warranty_until is null then null
              else a.warranty_until - d.today end as warranty_days_left,
         pl.next_due,
         a.valuable,
         (a.valuable and pp.asset_id is null) as place_private,
         a.gone_on,
         a.gone_note
    from public.asset a
    join public.household h on h.id = a.household_id
    left join public.asset_place_private pp on pp.asset_id = a.id and pp.household_id = a.household_id
    left join public.category c on c.id = a.category_id and c.household_id = a.household_id
    left join public.category pc on pc.id = c.parent_id and pc.household_id = c.household_id
    left join public.location l on l.id = coalesce(a.location_id, pp.location_id) and l.household_id = a.household_id
    left join public.asset pa on pa.id = a.parent_id and pa.household_id = a.household_id
    left join public.transaction_line tl on tl.id = a.transaction_line_id and tl.household_id = a.household_id
    left join public.money_transaction bt on bt.id = tl.transaction_id and bt.household_id = tl.household_id
    cross join lateral (
      select (now() at time zone h.timezone)::date as today
    ) z
    cross join lateral (
      select z.today,
             case when a.purchased_on is null then null
                  else greatest(0,
                         (extract(year from age(coalesce(case when a.status in ('sold', 'disposed', 'lost', 'used')
                                                              then coalesce(a.sold_on, a.gone_on, z.today) end, z.today),
                                                     a.purchased_on)) * 12
                        + extract(month from age(coalesce(case when a.status in ('sold', 'disposed', 'lost', 'used')
                                                               then coalesce(a.sold_on, a.gone_on, z.today) end, z.today),
                                                      a.purchased_on)))::integer)
             end as months_owned
    ) d
    cross join lateral (
      select case
               when a.purchase_price is null then null
               when a.useful_life_months is null or d.months_owned is null then a.purchase_price
               else round(a.purchase_price
                          - (a.purchase_price - least(coalesce(a.salvage_value, 0), a.purchase_price))
                            * least(d.months_owned::numeric / a.useful_life_months, 1), 2)
             end as book_value
    ) v
    left join lateral (
      select count(*)::integer as parts from public.asset x
       where x.household_id = a.household_id and x.parent_id = a.id
    ) ch on true
    left join lateral (
      select array_agg(t.id order by lower(t.name)) as tag_ids, array_agg(t.name order by lower(t.name)) as tag_names
        from public.asset_tag at2 join public.tag t on t.id = at2.tag_id and t.household_id = at2.household_id
       where at2.asset_id = a.id and at2.household_id = a.household_id
    ) tg on true
    left join lateral (
      select sum(g.cost) as maintenance_cost, max(g.done_on) as last_maintained_on
        from public.maintenance_log g
       where g.asset_id = a.id and g.household_id = a.household_id
    ) mt on true
    left join lateral (
      select min(m.next_due) as next_due from public.maintenance_plan m
       where m.asset_id = a.id and m.household_id = a.household_id and m.active
    ) pl on true;

create or replace view public.v_location_contents
with (security_invoker = true) as
  select l.id as location_id, l.household_id, l.name, l.path, l.parent_id,
         coalesce(st.lots, 0) as lots,
         coalesce(st.products, 0) as products,
         coalesce(st.value, 0) as stock_value,
         coalesce(ast.assets, 0) as assets,
         coalesce(ast.value, 0) as asset_value,
         greatest(st.last_moved, ast.last_changed) as last_touched,
         coalesce(st.stale_lots, 0) as stale_lots,
         coalesce(ast.stale_assets, 0) as stale_assets
    from public.location l
    left join lateral (
      select count(*)::integer as lots, count(distinct k.product_id)::integer as products,
             round(sum(k.qty_remaining * coalesce(k.unit_cost, 0)), 2) as value,
             max(lm.last_at) as last_moved,
             count(*) filter (where lm.last_at < now() - interval '365 days')::integer as stale_lots
        from public.stock_lot k
        left join lateral (
          select max(m.created_at) as last_at from public.stock_movement m
           where m.household_id = k.household_id and m.lot_id = k.id
        ) lm on true
       where k.household_id = l.household_id and k.location_id = l.id and k.qty_remaining > 0
    ) st on true
    left join lateral (
      select count(*)::integer as assets, coalesce(sum(v.current_value), 0) as value,
             max(v.updated_at) as last_changed,
             count(*) filter (where v.updated_at < now() - interval '365 days')::integer as stale_assets
        from public.v_asset v
       where v.household_id = l.household_id and v.location_id = l.id
         and v.status not in ('sold', 'disposed', 'lost', 'used')
    ) ast on true;

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
       and a.status not in ('sold', 'disposed', 'lost', 'used')
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

create or replace function public.ask_warranty(p_household uuid, p_within_days integer default 60)
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
             and a.status not in ('sold', 'disposed', 'lost', 'used') and not coalesce(a.lifetime_warranty, false)
             and a.warranty_until between v_today and v_today + p_within_days
           order by a.warranty_until, a.name limit 10) x;
  return v_out;
end;
$$;


-- Attention: no warranty / service alerts for a thing that was used up.
alter function private.attention_items(uuid) rename to attention_items_v114;
revoke execute on function private.attention_items_v114(uuid) from public, anon, authenticated;

create function private.attention_items(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select i.* from private.attention_items_v114(p_household) i
   where not (i.entity_type = 'asset' and i.kind in ('warranty_ending', 'service_due')
              and exists (select 1 from public.asset a
                           where a.id = i.entity_id and a.household_id = p_household and a.status = 'used'))
$$;

revoke execute on function private.attention_items(uuid) from public, anon, authenticated;

-- ── Photo by scan: live photos ────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attachment') then
    alter publication supabase_realtime add table public.attachment;
  end if;
end;
$$;

update public.app_meta set value = '115' where key = 'schema_version';
