-- Phase 6 · 48 — ⌘K search over everything (MASTER_PLAN §3.7 search_index, §5.4)
-- One ranked list across products (English + Sinhala names, barcodes), things (name, maker, model,
-- serial, A-tag), places (path), bills (shop, invoice no, notes), bill lines (as printed) and
-- categories. Matching: substring (ilike, served by trigram GIN indexes) or trigram word
-- similarity for typos. Runs with the caller's RLS.

create index product_name_trgm_idx on public.product using gin (name extensions.gin_trgm_ops);
create index product_name_si_trgm_idx on public.product using gin (name_si extensions.gin_trgm_ops) where name_si is not null;
create index product_barcode_trgm_idx on public.product_barcode using gin (barcode extensions.gin_trgm_ops);
create index asset_name_trgm_idx on public.asset using gin (name extensions.gin_trgm_ops);
create index asset_model_trgm_idx on public.asset using gin
  ((coalesce(manufacturer, '') || ' ' || coalesce(model_no, '') || ' ' || coalesce(serial_no, '')) extensions.gin_trgm_ops);
create index location_path_trgm_idx on public.location using gin (path extensions.gin_trgm_ops);
create index money_transaction_search_trgm_idx on public.money_transaction using gin
  ((coalesce(payee_text, '') || ' ' || coalesce(invoice_no, '') || ' ' || coalesce(notes, '')) extensions.gin_trgm_ops);
create index transaction_line_raw_name_trgm_idx on public.transaction_line using gin (raw_name extensions.gin_trgm_ops);

-- type: product | asset | location | transaction | line | category
-- ref_id: the record to open (a line opens its bill: ref_id = transaction, id = line)
create function public.search_all(p_household uuid, p_q text, p_limit integer default 20)
returns table (type text, id uuid, ref_id uuid, title text, subtitle text, occurred_on date, amount numeric, score real)
language sql
stable
set search_path = ''
as $$
  with q as (
    select btrim(p_q) as raw,
           '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  hits as (
    select 'product'::text as type, p.id, p.id as ref_id, p.name as title, p.name_si as subtitle,
           null::date as occurred_on, null::numeric as amount,
           greatest(extensions.word_similarity(q.raw, p.name), extensions.word_similarity(q.raw, coalesce(p.name_si, ''))) as score,
           (p.name ilike q.pat or p.name_si ilike q.pat
            or exists (select 1 from public.product_barcode b
                        where b.household_id = p.household_id and b.product_id = p.id and b.barcode ilike q.pat)) as sub
      from public.product p, q
     where p.household_id = p_household and not p.archived
    union all
    select 'asset', a.id, a.id, a.name,
           concat_ws(' · ', 'A-' || lpad(a.asset_no::text, 4, '0'), a.manufacturer, a.model_no),
           null, null,
           greatest(extensions.word_similarity(q.raw, a.name),
                    extensions.word_similarity(q.raw, coalesce(a.manufacturer, '') || ' ' || coalesce(a.model_no, ''))),
           (a.name ilike q.pat
            or (coalesce(a.manufacturer, '') || ' ' || coalesce(a.model_no, '') || ' ' || coalesce(a.serial_no, '')) ilike q.pat
            or ('A-' || lpad(a.asset_no::text, 4, '0')) ilike q.pat)
      from public.asset a, q
     where a.household_id = p_household
    union all
    select 'location', l.id, l.id, l.name, l.path, null, null,
           extensions.word_similarity(q.raw, l.path), l.path ilike q.pat
      from public.location l, q
     where l.household_id = p_household
    union all
    select 'transaction', t.id, t.id, coalesce(t.payee_text, t.type), t.invoice_no, t.occurred_on, t.total,
           extensions.word_similarity(q.raw, coalesce(t.payee_text, '')),
           (coalesce(t.payee_text, '') || ' ' || coalesce(t.invoice_no, '') || ' ' || coalesce(t.notes, '')) ilike q.pat
      from public.money_transaction t, q
     where t.household_id = p_household
    union all
    select 'line', l.id, l.transaction_id, l.raw_name, t.payee_text, t.occurred_on, l.amount,
           extensions.word_similarity(q.raw, l.raw_name), l.raw_name ilike q.pat
      from public.transaction_line l
      join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id, q
     where l.household_id = p_household
    union all
    select 'category', c.id, c.id, c.name, pc.name, null, null,
           extensions.word_similarity(q.raw, c.name), c.name ilike q.pat
      from public.category c
      left join public.category pc on pc.id = c.parent_id and pc.household_id = c.household_id, q
     where c.household_id = p_household and not c.archived
  ),
  ranked as (
    select h.*, (case when h.sub then 1 else 0 end + h.score)::real as rank,
           row_number() over (partition by h.type order by (case when h.sub then 1 else 0 end + h.score) desc,
                                                     h.occurred_on desc nulls last) as n
      from hits h, q
     where length(q.raw) >= 2 and (h.sub or h.score >= 0.45)
  )
  select r.type, r.id, r.ref_id, r.title, r.subtitle, r.occurred_on, r.amount, r.rank
    from ranked r
   where r.n <= case when r.type in ('transaction', 'line') then 5 else 8 end
   order by r.rank desc, r.occurred_on desc nulls last
   limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

revoke execute on function public.search_all(uuid, text, integer) from public, anon;
grant execute on function public.search_all(uuid, text, integer) to authenticated;

update public.app_meta set value = '48' where key = 'schema_version';
