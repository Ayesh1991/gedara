-- Phase 9 · 88 — a bank alert's line is the whole bill, never a pantry item (9b.1 fix).
--
-- An alert saved as an expense gets one line named after the shop ("CARGILLS FOODCITY RAJAGIRIYA LK").
-- In a Grocery category that line inherited Grocery's default destiny `stock`, so the matcher offered it
-- a product; one "Yes" on prod linked it to Carrot and taught "cargills foodcity …" → Carrot, which then
-- came back as a 99 % rule for every Cargills alert. Now:
--   * such a line is `expense` when it is made (a trigger after the normalising one);
--   * rpc_line_link_product refuses a product for it and never learns a name from it;
--   * the matching bundle leaves bank-alert lines out of the pantry questions and the accuracy test;
--   * repair: bank-alert lines that never fed the pantry lose their product and become `expense`, names
--     learned from them as products are forgotten, and their open product suggestions go stale.

create function private.transaction_line_alert_whole_bill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.destiny = 'stock' and new.product_id is null and exists (
       select 1 from public.money_transaction t
        where t.id = new.transaction_id and t.household_id = new.household_id and t.source = 'sms') then
    new.destiny := 'expense';
  end if;
  return new;
end;
$$;

-- (runs after transaction_line_normalise, which sets the category's default destiny: same timing, name order)
create trigger transaction_line_sms_whole_bill
  before insert on public.transaction_line
  for each row execute function private.transaction_line_alert_whole_bill();

create or replace function public.rpc_line_link_product(p_line uuid, p_product uuid, p_destiny text default 'stock')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.transaction_line;
  v_merchant uuid;
  v_alert    boolean;
begin
  select * into v_line from public.transaction_line l where l.id = p_line for update;
  if not found or not private.can_write(v_line.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_destiny not in ('stock', 'expense') or (p_destiny = 'stock') <> (p_product is not null) then
    raise exception 'a pantry line needs a product, a not-pantry line none' using errcode = '22023';
  end if;
  if exists (select 1 from public.stock_lot k where k.household_id = v_line.household_id and k.transaction_line_id = v_line.id) then
    raise exception 'this line already feeds the pantry' using errcode = 'GDRTD';
  end if;
  -- a bank alert's line is the whole bill (9b.1 fix): never one pantry product, and its shop name is no product name
  select t.source = 'sms' into v_alert from public.money_transaction t
   where t.id = v_line.transaction_id and t.household_id = v_line.household_id;
  if v_alert and p_destiny = 'stock' then
    raise exception 'a bank alert''s line is the whole bill, not a pantry item' using errcode = '23514';
  end if;
  if p_product is not null and not exists (select 1 from public.product p where p.id = p_product
       and p.household_id = v_line.household_id and not p.archived) then
    raise exception 'no such product' using errcode = '23503';
  end if;

  update public.transaction_line l set product_id = p_product, destiny = p_destiny where l.id = v_line.id;

  select t.merchant_id into v_merchant from public.money_transaction t
   where t.id = v_line.transaction_id and t.household_id = v_line.household_id;
  if private.bill_name_norm(v_line.raw_name) <> '' and not coalesce(v_alert, false) then
    insert into public.product_alias as a (household_id, alias_norm, destiny, product_id, merchant_id)
    values (v_line.household_id, left(private.bill_name_norm(v_line.raw_name), 200), p_destiny, p_product, v_merchant)
    on conflict (household_id, alias_norm) do update
      set destiny = excluded.destiny, product_id = excluded.product_id, merchant_id = coalesce(excluded.merchant_id, a.merchant_id),
          hits = a.hits + 1, last_used_at = now();
  end if;
end;
$$;

create or replace function public.rpc_match_bundle(p_household uuid, p_run uuid, p_mode text default 'run')
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
                      from public.match_suggestion s where s.household_id = p_household),
    -- the household's own payee → category choices (9b.1; the app's defaults fill the rest)
    'payee_category', (select coalesce(jsonb_agg(jsonb_build_object('payee_norm', c.payee_norm, 'category_id', c.category_id)), '[]')
                         from public.payee_category c where c.household_id = p_household));

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
      -- how alerts of the last 120 days were booked (9b.1: evidence that disagrees → "Check past bookings";
      -- your past choices as a weak hint)
      'booked', (select coalesce(jsonb_agg(jsonb_build_object('sms_id', s.id, 'transaction_id', t.id, 'type', t.type,
                   'account_id', t.account_id, 'to_account_id', t.to_account_id, 'total', t.total, 'source', t.source,
                   'lines', (select count(*) from public.transaction_line l where l.transaction_id = t.id and l.household_id = t.household_id),
                   'line_id', (select l.id from public.transaction_line l where l.transaction_id = t.id and l.household_id = t.household_id order by l.line_no limit 1),
                   'category_id', (select l.category_id from public.transaction_line l where l.transaction_id = t.id and l.household_id = t.household_id order by l.line_no limit 1),
                   'has_fee', exists (select 1 from public.money_transaction f where f.related_id = t.id and f.household_id = t.household_id))), '[]')
                   from public.sms_message s
                   join public.money_transaction t on t.id = s.transaction_id and t.household_id = s.household_id
                  where s.household_id = p_household and s.received_at > now() - interval '120 days'),
      -- pantry lines still without a product (newest first)
      'lines', (select coalesce(jsonb_agg(x order by x ->> 'occurred_on' desc), '[]') from (
                  select jsonb_build_object('id', l.id, 'fingerprint', l.fingerprint, 'raw_name', l.raw_name, 'qty', l.qty,
                           'unit_text', l.unit_text, 'amount', l.amount, 'category_id', l.category_id, 'destiny', l.destiny,
                           'shop', coalesce(m.name, t.payee_text), 'occurred_on', t.occurred_on) as x
                    from public.transaction_line l
                    join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
                    left join public.merchant m on m.id = t.merchant_id and m.household_id = t.household_id
                   where l.household_id = p_household and l.destiny = 'stock' and l.product_id is null and l.amount > 0
                     and t.type = 'expense' and t.source <> 'sms'
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
      -- the alerts (parsed fields only, never the body): payees' confirmations are the evidence (9b.1)
      'sms', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'sender', s.sender, 'body', '', 'received_at', s.received_at,
                'fingerprint', s.fingerprint, 'kind', s.kind, 'parser', s.parser, 'institution', s.institution,
                'last_digits', s.last_digits, 'account_id', s.account_id, 'amount', s.amount, 'currency', s.currency,
                'balance_after', s.balance_after, 'merchant_text', s.merchant_text, 'bank_txn_id', s.bank_txn_id,
                'occurred_on', s.occurred_on, 'occurred_at', s.occurred_at, 'transaction_id', s.transaction_id,
                'ignored', s.ignored) order by s.received_at), '[]')
                from public.sms_message s
               where s.household_id = p_household
                 and s.received_at > now() - interval '200 days'),
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
                     and (l.product_id is not null or l.destiny = 'asset') and t.source <> 'sms'
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

-- ── Repair ──────────────────────────────────────────────────────────────────
update public.match_suggestion s set status = 'stale', updated_at = now()
  from public.transaction_line l
  join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
 where s.line_id = l.id and s.household_id = l.household_id and t.source = 'sms'
   and s.status = 'pending' and s.task in ('line_product', 'line_thing');

delete from public.product_alias a
 using public.transaction_line l
  join public.money_transaction t on t.id = l.transaction_id and t.household_id = l.household_id
 where a.household_id = l.household_id and t.source = 'sms' and a.destiny = 'stock'
   and a.alias_norm = left(private.bill_name_norm(l.raw_name), 200);

update public.transaction_line l set product_id = null, destiny = 'expense'
  from public.money_transaction t
 where t.id = l.transaction_id and t.household_id = l.household_id and t.source = 'sms' and l.destiny = 'stock'
   and not exists (select 1 from public.stock_lot k where k.household_id = l.household_id and k.transaction_line_id = l.id);

update public.app_meta set value = '88' where key = 'schema_version';
