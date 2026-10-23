-- Phase 9 · 86 — "Check past bookings" (9b.1).
--
-- Evidence that disagrees with a past booking becomes a suggestion a person decides:
--   * sms_rebook       — a transfer debit (e.g. CEFT Rs 25,025) booked as an expense while the card
--                        payment it paid (Rs 25,000) is there: the expense goes, the debit joins the
--                        transfer (made now, or the one already booked), the Rs 25 is the transfer's fee;
--   * sms_recategorise — a booked category that disagrees with a payee's confirmation (Dialog says it
--                        was a reload, the line says Banking & fees).
-- rpc_sms_rebook does the whole fix in one transaction with the same routines a person uses (delete,
-- save with fee, link). The bundle gains how alerts were booked and the payee map.

alter table public.match_suggestion drop constraint match_suggestion_task_check;
alter table public.match_suggestion add constraint match_suggestion_task_check
  check (task in ('line_product', 'line_category', 'line_thing', 'sms_category', 'sms_link', 'sms_rebook', 'sms_recategorise'));

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

-- p: { debit_sms: uuid, delete_tx: [uuid], transfer_id: uuid | null, to_account_id: uuid | null,
--       payment_sms: uuid | null, total: numeric, fee: numeric, fee_category_id: uuid | null }
-- transfer_id given → the debit joins that transfer (moved to the debit's account, fee re-made);
-- otherwise a new transfer is posted from the debit (and the card payment alert, when there is one).
create function public.rpc_sms_rebook(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_debit     public.sms_message;
  v_pay       public.sms_message;
  v_t         public.money_transaction;
  v_tx        uuid;
  v_total     numeric := (p ->> 'total')::numeric;
  v_fee       numeric := coalesce((p ->> 'fee')::numeric, 0);
  v_fee_json  jsonb;
  v_result    jsonb;
begin
  select * into v_debit from public.sms_message s where s.id = (p ->> 'debit_sms')::uuid;
  if not found or not private.can_write(v_debit.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_debit.kind <> 'bank_debit' or v_debit.account_id is null or v_total is null or v_total <= 0 or v_fee < 0
     or v_debit.amount is distinct from v_total + v_fee then
    raise exception 'the debit must equal the transfer plus its fee' using errcode = '23514';
  end if;
  v_fee_json := case when v_fee > 0 then jsonb_build_object('amount', v_fee, 'category_id', p ->> 'fee_category_id') end;

  -- 1. The wrong entries go (only expenses / income that these alerts point at).
  for v_tx in select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p -> 'delete_tx', '[]')) loop
    if not exists (select 1 from public.money_transaction t
                    where t.id = v_tx and t.household_id = v_debit.household_id and t.type in ('expense', 'income')
                      and exists (select 1 from public.sms_message s where s.transaction_id = t.id
                                    and s.id in (v_debit.id, (p ->> 'payment_sms')::uuid))) then
      raise exception 'only the entries these alerts were booked as can go' using errcode = '23514';
    end if;
    perform public.rpc_delete_transaction(v_tx, false);
  end loop;

  if p ->> 'transfer_id' is not null then
    -- 2a. The transfer is already booked (from the card payment): the debit joins it.
    select * into v_t from public.money_transaction t
     where t.id = (p ->> 'transfer_id')::uuid and t.household_id = v_debit.household_id and t.type = 'transfer';
    if not found or v_t.total <> v_total then
      raise exception 'no such transfer' using errcode = '23514';
    end if;
    perform private.save_transaction(jsonb_build_object(
      'id', v_t.id, 'household_id', v_t.household_id, 'type', 'transfer', 'account_id', v_debit.account_id,
      'to_account_id', v_t.to_account_id, 'payee_text', v_t.payee_text, 'occurred_on', v_t.occurred_on,
      'occurred_at', v_t.occurred_at, 'invoice_no', v_t.invoice_no, 'total', v_t.total, 'notes', v_t.notes,
      'keep_lines', true, 'lines', '[]'::jsonb, 'fee', v_fee_json), 'sms');
    perform public.rpc_sms_link(array[v_debit.id], v_t.id);
    v_result := jsonb_build_object('transfer_id', v_t.id, 'joined', true);
  else
    -- 2b. A new transfer from the debit (with the card payment alert, if it is waiting).
    if (p ->> 'to_account_id') is null then
      raise exception 'where did the money go?' using errcode = '23514';
    end if;
    if p ->> 'payment_sms' is not null then
      select * into v_pay from public.sms_message s
       where s.id = (p ->> 'payment_sms')::uuid and s.household_id = v_debit.household_id;
    end if;
    v_result := public.rpc_sms_post(
      array_remove(array[v_debit.id, case when v_pay.id is not null and v_pay.transaction_id is null then v_pay.id end], null),
      jsonb_build_object('household_id', v_debit.household_id, 'type', 'transfer', 'account_id', v_debit.account_id,
        'to_account_id', (p ->> 'to_account_id')::uuid, 'occurred_on', v_debit.occurred_on, 'occurred_at', v_debit.occurred_at,
        'total', v_total, 'lines', '[]'::jsonb, 'fee', v_fee_json));
  end if;
  return v_result;
end;
$$;

revoke execute on function public.rpc_sms_rebook(jsonb) from public, anon;
grant execute on function public.rpc_sms_rebook(jsonb) to authenticated;

-- The accuracy report gains (9b.1): main-category accuracy next to the exact one, how many answers
-- evidence confirmed, how many past choices evidence contradicted (left out of the score), and how many
-- alerts name no shop (never asked, kept apart from the AI's score).
create or replace view public.v_match_accuracy
with (security_invoker = true) as
  select e.household_id, e.task, count(*)::integer as n,
         count(*) filter (where e.rule_correct is not null)::integer as rule_answered,
         count(*) filter (where e.rule_correct)::integer as rule_correct,
         count(*) filter (where e.ai_correct is not null)::integer as ai_answered,
         count(*) filter (where e.ai_correct)::integer as ai_correct,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9)::integer as sure_n,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9 and e.ai_correct)::integer as sure_correct,
         max(e.created_at) as tested_at,
         count(*) filter (where (e.ai ->> 'main_correct')::boolean)::integer as ai_main_correct,
         count(*) filter (where e.truth ->> 'evidence' = 'true')::integer as evidence_n,
         count(*) filter (where e.truth ->> 'contradicted' = 'true')::integer as contradicted_n,
         count(*) filter (where e.truth ->> 'no_shop' = 'true')::integer as no_shop_n
    from public.match_eval e
   group by e.household_id, e.task;

update public.app_meta set value = '86' where key = 'schema_version';
