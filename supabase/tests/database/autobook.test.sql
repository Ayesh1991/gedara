-- Phase 9c (migration 95): Gedara books certain kinds by itself. The record per kind is saved with a run;
-- the owner switches a kind on only once it qualifies (≥ 99 % on ≥ 20); rpc_match_autobook (service role,
-- open run) books with the person RPCs as the owner, skips kinds off / unqualified / mismatched / undone
-- / another household's alerts; members see "What changed", mark it right or undo it (a bill moved off
-- "to be matched" goes back, an entry made is deleted, a line loses its product) and an undone alert is
-- never booked by itself again. Another household can't read, mark or undo any of it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fa101', 'auto-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa102', 'auto-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa103', 'auto-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fb101', 'auto-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fa1aa', 'Auto A'),
  ('00000000-0000-0000-0000-0000000fb1bb', 'Auto B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa101', 'owner'),
  ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa102', 'member'),
  ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fb1bb', '00000000-0000-0000-0000-0000000fb101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fa0c1', '00000000-0000-0000-0000-0000000fa1aa', 'services', 'Services', 'expense'),
  ('00000000-0000-0000-0000-0000000fa0c3', '00000000-0000-0000-0000-0000000fa1aa', 'grocery', 'Grocery', 'stock');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000fa0c2', '00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa0c1', 'Banking & fees');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on, is_suspense) values
  ('00000000-0000-0000-0000-0000000fa0a1', '00000000-0000-0000-0000-0000000fa1aa', 'BOC', 'bank', 'BOC', '708', null, 100000, '2026-10-01', false),
  ('00000000-0000-0000-0000-0000000fa0a2', '00000000-0000-0000-0000-0000000fa1aa', 'Sampath card', 'credit_card', 'Sampath', '4417', 300000, 0, '2026-10-01', false),
  ('00000000-0000-0000-0000-0000000fa0a3', '00000000-0000-0000-0000-0000000fa1aa', 'Card — to be matched', 'credit_card', null, null, null, 0, '2026-10-01', true),
  ('00000000-0000-0000-0000-0000000fb0a1', '00000000-0000-0000-0000-0000000fb1bb', 'Cash B', 'cash', null, null, null, 0, '2026-10-01', false);
insert into product (id, household_id, name, stock_unit_id, due_type) values
  ('00000000-0000-0000-0000-0000000fa0d1', '00000000-0000-0000-0000-0000000fa1aa', 'Keeri samba', pg_temp.u('g'), 'none');
-- a scanned bill waiting in "to be matched", with a pantry line not linked yet
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint, source) values
  ('00000000-0000-0000-0000-0000000fa0e1', '00000000-0000-0000-0000-0000000fa1aa', 'expense', '00000000-0000-0000-0000-0000000fa0a3',
   'Cargills', current_date - 2, 4520, 'bauto1', 'scan');
insert into transaction_line (id, household_id, transaction_id, line_no, raw_name, category_id, amount, destiny, fingerprint) values
  ('00000000-0000-0000-0000-0000000fa0f1', '00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa0e1', 0,
   'KEERI SMBA 5KG', '00000000-0000-0000-0000-0000000fa0c3', 4520, 'stock', 'bauto1-0-a');
insert into sms_message (id, household_id, channel, sender, received_at, body, fingerprint, parser_version, kind, institution,
                         account_id, amount, merchant_text, occurred_on) values
  ('00000000-0000-0000-0000-0000000fa051', '00000000-0000-0000-0000-0000000fa1aa', 'backup', 'BOC', now() - interval '3 hours',
   'CEFT Transfer Debit Rs 25025.00', 'sauto1', 2, 'bank_debit', 'BOC', '00000000-0000-0000-0000-0000000fa0a1', 25025, 'CEFT Transfer Debit', current_date),
  ('00000000-0000-0000-0000-0000000fa052', '00000000-0000-0000-0000-0000000fa1aa', 'backup', 'SAMPCCTXN', now() - interval '170 minutes',
   'Payment received 25000.00', 'sauto2', 2, 'card_payment', 'Sampath', '00000000-0000-0000-0000-0000000fa0a2', 25000, 'Payment received', current_date),
  ('00000000-0000-0000-0000-0000000fa053', '00000000-0000-0000-0000-0000000fa1aa', 'backup', 'SAMPCCTXN', now() - interval '2 days',
   'Purchase 4520.00 at CARGILLS', 'sauto3', 2, 'card_charge', 'Sampath', '00000000-0000-0000-0000-0000000fa0a2', 4520, 'CARGILLS FOOD CITY', current_date - 2),
  ('00000000-0000-0000-0000-0000000fa054', '00000000-0000-0000-0000-0000000fa1aa', 'backup', 'PeoplesCard', now() - interval '1 day',
   'Your statement is ready', 'sauto4', 2, 'info', 'People''s', null, 1, 'Statement', current_date - 1),
  ('00000000-0000-0000-0000-0000000fb051', '00000000-0000-0000-0000-0000000fb1bb', 'backup', 'BOC', now() - interval '1 day',
   'Debit Rs 100.00', 'sautob1', 2, 'bank_debit', 'BOC', null, 100, 'SHOP B', current_date - 1);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa101","role":"authenticated"}';

-- ── Switches need a record ────────────────────────────────────────────────────
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fa1aa', '{"auto": ["alert_transfer"]}')$$,
  '23514', 'not proven yet', 'a kind with no record yet cannot be switched on');
insert into t_c values ('run1', to_jsonb(rpc_match_request('00000000-0000-0000-0000-0000000fa1aa', 'import')));

reset role;
set local request.jwt.claims to '';
set local role service_role;
select lives_ok($$select rpc_match_save('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run1'),
  '{"record": {"alert_transfer": {"right": 25, "of": 25}, "alert_link": {"right": 30, "of": 30}, "alert_note": {"right": 3, "of": 3},
               "category_rule": {"right": 19, "of": 20}, "line_product": {"right": 58, "of": 58}, "bogus": {"right": 1, "of": 1},
               "category_evidence": {"right": 9, "of": 2}}, "stats": {}}')$$, 'a run saves the record per kind');
select is((select auto_record from match_setting where household_id = '00000000-0000-0000-0000-0000000fa1aa'),
  '{"alert_link": {"of": 30, "right": 30}, "alert_note": {"of": 3, "right": 3}, "line_product": {"of": 58, "right": 58}, "category_rule": {"of": 20, "right": 19}, "alert_transfer": {"of": 25, "right": 25}}'::jsonb,
  'known kinds only, and never more right than cases');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa101","role":"authenticated"}';
select lives_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fa1aa',
  '{"auto": ["alert_transfer", "alert_link", "line_product", "alert_transfer"]}')$$, 'the owner switches on three proven kinds');
select is((select auto from match_setting where household_id = '00000000-0000-0000-0000-0000000fa1aa'),
  '["alert_link", "alert_transfer", "line_product"]'::jsonb, 'saved once each');
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fa1aa', '{"auto": ["alert_link", "alert_note"]}')$$,
  '23514', 'not proven yet', '3 of 3 is not enough to switch notes on');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa102","role":"authenticated"}';
select throws_ok($$select rpc_match_settings_save('00000000-0000-0000-0000-0000000fa1aa', '{"auto": []}')$$,
  '42501', null, 'a member cannot change the switches');
insert into t_c values ('run2', to_jsonb(rpc_match_request('00000000-0000-0000-0000-0000000fa1aa', 'import')));
select throws_ok($$select rpc_match_autobook('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run2'), '[]')$$,
  '42501', null, 'members cannot call the booking function (service role only)');

-- ── Booking (service role) ────────────────────────────────────────────────────
reset role;
set local request.jwt.claims to '';
set local role service_role;
select is(rpc_match_autobook('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run2'), jsonb_build_array(
    jsonb_build_object('kind', 'alert_transfer', 'action', 'post',
      'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa051', '00000000-0000-0000-0000-0000000fa052'),
      'payload', jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000fa1aa', 'type', 'transfer',
        'account_id', '00000000-0000-0000-0000-0000000fa0a1', 'to_account_id', '00000000-0000-0000-0000-0000000fa0a2',
        'occurred_on', current_date, 'total', 25000, 'lines', '[]'::jsonb,
        'fee', jsonb_build_object('amount', 25, 'category_id', '00000000-0000-0000-0000-0000000fa0c2')),
      'summary', jsonb_build_object('payee', 'CEFT Transfer Debit', 'amount', 25000)),
    jsonb_build_object('kind', 'alert_link', 'action', 'link', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa053'),
      'tx_id', '00000000-0000-0000-0000-0000000fa0e1', 'summary', jsonb_build_object('payee', 'CARGILLS FOOD CITY', 'amount', 4520)),
    jsonb_build_object('kind', 'line_product', 'action', 'line', 'sms_ids', '[]'::jsonb,
      'line_id', '00000000-0000-0000-0000-0000000fa0f1', 'product_id', '00000000-0000-0000-0000-0000000fa0d1', 'summary', '{}'::jsonb),
    -- switched off / not qualified / the wrong action for its kind / another household's alert
    jsonb_build_object('kind', 'alert_note', 'action', 'seen', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa054'), 'summary', '{}'::jsonb),
    jsonb_build_object('kind', 'category_rule', 'action', 'post', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa054'), 'summary', '{}'::jsonb),
    jsonb_build_object('kind', 'alert_link', 'action', 'seen', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa054'), 'summary', '{}'::jsonb),
    jsonb_build_object('kind', 'alert_link', 'action', 'link', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fb051'),
      'tx_id', '00000000-0000-0000-0000-0000000fa0e1', 'summary', '{}'::jsonb))),
  '{"failed": 0, "booked": 3, "skipped": 4, "line_ids": ["00000000-0000-0000-0000-0000000fa0f1"], "sms_ids": ["00000000-0000-0000-0000-0000000fa051", "00000000-0000-0000-0000-0000000fa052", "00000000-0000-0000-0000-0000000fa053"]}'::jsonb, 'books the three switched-on certain items, skips the rest');
select is((select count(distinct s.transaction_id) || ' ' || max(t.type) || ' ' || max(t.total) || ' ' || bool_and(s.reviewed_by = '00000000-0000-0000-0000-0000000fa101')
             || ' ' || (select count(*) from money_transaction f where f.related_id = max(t.id::text)::uuid)
             from sms_message s join money_transaction t on t.id = s.transaction_id where s.fingerprint in ('sauto1', 'sauto2')),
  '1 transfer 25000.00 true 1', 'the debit + payment became one transfer (with its fee), booked as the owner');
select is((select account_id from money_transaction where id = '00000000-0000-0000-0000-0000000fa0e1'),
  '00000000-0000-0000-0000-0000000fa0a2'::uuid, 'the card charge linked to its bill, which moved off "to be matched"');
select is((select product_id || ' ' || (select count(*) from stock_lot k where k.transaction_line_id = l.id) from transaction_line l
             where l.id = '00000000-0000-0000-0000-0000000fa0f1'), '00000000-0000-0000-0000-0000000fa0d1 0',
  'the old line got its learned product, no stock made');
select is(auth.uid(), null, 'the owner''s identity ends with the call');
select throws_ok($$select rpc_match_autobook('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run1'), '[]')$$,
  '42501', null, 'only inside an open run');

-- ── What changed (members) ────────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa102","role":"authenticated"}';
select is((select count(*)::int from match_autobook), 3, 'the member sees the three bookings');
select is((select item_key like 'autobook:3:%' from attention_feed('00000000-0000-0000-0000-0000000fa1aa') where kind = 'autobook_review'),
  true, 'Attention says three bookings wait to be looked at');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';
select is((select count(*)::int from match_autobook), 0, 'another household sees none of it');
select throws_ok($$select rpc_match_autobook_seen(array['00000000-0000-0000-0000-0000000fa1aa'::uuid])$$, '42501', null,
  'unknown ids are refused');
select throws_ok(format('select rpc_match_autobook_undo(%L)', (select id from match_autobook limit 1)), '42501', null,
  'another household cannot undo (it cannot even see the id)');
select throws_ok($$insert into match_autobook (household_id, kind, action) values ('00000000-0000-0000-0000-0000000fb1bb', 'alert_note', 'seen')$$,
  '42501', null, 'nobody writes the log directly');

reset role;
insert into t_c select 'transfer', to_jsonb(id) from match_autobook where kind = 'alert_transfer';
insert into t_c select 'link', to_jsonb(id) from match_autobook where kind = 'alert_link';
insert into t_c select 'line', to_jsonb(id) from match_autobook where kind = 'line_product';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';
select throws_ok($$select rpc_match_autobook_seen(array[(select (v #>> '{}')::uuid from t_c where k = 'transfer')])$$, '42501', null,
  'another household cannot mark it right');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa103","role":"authenticated"}';
select throws_ok($$select rpc_match_autobook_undo((select (v #>> '{}')::uuid from t_c where k = 'link'))$$, '42501', null,
  'a viewer cannot undo');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa102","role":"authenticated"}';
select is(rpc_match_autobook_seen(array[(select (v #>> '{}')::uuid from t_c where k = 'transfer'), (select (v #>> '{}')::uuid from t_c where k = 'line')]),
  2, '"Looks right" on two');
select lives_ok($$select rpc_match_autobook_undo((select (v #>> '{}')::uuid from t_c where k = 'link'))$$, 'the member undoes the link');
select is((select (select transaction_id from sms_message where fingerprint = 'sauto3') is null
                  and account_id = '00000000-0000-0000-0000-0000000fa0a3' from money_transaction where id = '00000000-0000-0000-0000-0000000fa0e1'),
  true, 'the alert waits again and its bill is back in "to be matched"');
select ok(not exists (select 1 from attention_feed('00000000-0000-0000-0000-0000000fa1aa') where kind = 'autobook_review'),
  'nothing left to look at');
select lives_ok($$select rpc_match_autobook_undo((select (v #>> '{}')::uuid from t_c where k = 'transfer'));
                  select rpc_match_autobook_undo((select (v #>> '{}')::uuid from t_c where k = 'line'))$$,
  'a reviewed booking can still be undone');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000fa1aa' and type = 'transfer')
          + (select count(*)::int from transaction_line where id = '00000000-0000-0000-0000-0000000fa0f1' and product_id is not null),
  0, 'the transfer (and its fee) is gone, the line has no product again');

-- ── Never again by itself ─────────────────────────────────────────────────────
insert into t_c values ('run3', to_jsonb(rpc_match_request('00000000-0000-0000-0000-0000000fa1aa', 'import')));
reset role;
set local request.jwt.claims to '';
set local role service_role;
select is((select rpc_match_bundle('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run3'))
             #> '{autobook_undone,sms}' @> '["00000000-0000-0000-0000-0000000fa051"]'),
  true, 'the bundle tells the run what was undone');
select is(rpc_match_autobook('00000000-0000-0000-0000-0000000fa1aa', (select (v #>> '{}')::uuid from t_c where k = 'run3'), jsonb_build_array(
    jsonb_build_object('kind', 'alert_link', 'action', 'link', 'sms_ids', jsonb_build_array('00000000-0000-0000-0000-0000000fa053'),
      'tx_id', '00000000-0000-0000-0000-0000000fa0e1', 'summary', '{}'::jsonb))) ->> 'skipped', '1',
  'an undone alert is not booked by itself again');

select * from finish();
rollback;
