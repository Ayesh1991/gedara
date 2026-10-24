-- Phase 9b.1 fix (migration 88): a bank alert saved as a Grocery expense gets one line — the whole bill.
-- It is not a pantry item: made as `expense`, a product can't be linked to it, and its shop name is never
-- learned as a product name. A scanned bill's Grocery line still goes to the pantry.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000fa801', 'alertline-owner@test.local');
insert into household (id, name) values ('00000000-0000-0000-0000-0000000fa8aa', 'Alert lines');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fa8aa', '00000000-0000-0000-0000-0000000fa801', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fa8c1', '00000000-0000-0000-0000-0000000fa8aa', 'grocery', 'Grocery', 'stock');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fa8a1', '00000000-0000-0000-0000-0000000fa8aa', 'Seylan Card', 'credit_card', 'Seylan', '6029', 100000, 0, '2026-08-01');
insert into product (id, household_id, name, stock_unit_id) values
  ('00000000-0000-0000-0000-0000000fa8f1', '00000000-0000-0000-0000-0000000fa8aa', 'Carrot',
   (select id from unit where household_id is null and code = 'g'));
-- a scanned bill's line (fixture): Grocery → pantry
insert into money_transaction (id, household_id, type, account_id, occurred_on, total, source, fingerprint) values
  ('00000000-0000-0000-0000-0000000fa8e1', '00000000-0000-0000-0000-0000000fa8aa', 'expense', '00000000-0000-0000-0000-0000000fa8a1',
   '2026-08-25', 500, 'scan', 'bal1');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000fa8aa', '00000000-0000-0000-0000-0000000fa8e1', 0, 'CARROT 500G',
   '00000000-0000-0000-0000-0000000fa8c1', 500, 'bal1-0-a');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa801","role":"authenticated"}';

select is(rpc_sms_import('00000000-0000-0000-0000-0000000fa8aa', '[
  {"sender":"Seylan Bank","body":"Seylan Card ...6029 debit Txn 100630011 of LKR 1,950.00 done on 25/08/2026 10:00:00 AM at CARGILLS FOODCITY RAJAGIRIYA LK. Avl bal 98,050.00",
   "received_at":"2026-08-25T04:30:00Z","fingerprint":"sbal1","kind":"card_charge","institution":"Seylan","last_digits":"6029","amount":1950,
   "merchant_text":"CARGILLS FOODCITY RAJAGIRIYA LK","occurred_on":"2026-08-25"}]'::jsonb) ->> 'stored', '1', 'the alert is stored');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sbal1')], '{
  "household_id":"00000000-0000-0000-0000-0000000fa8aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fa8a1",
  "payee_text":"CARGILLS FOODCITY RAJAGIRIYA LK","occurred_on":"2026-08-25","total":1950,
  "lines":[{"raw_name":"CARGILLS FOODCITY RAJAGIRIYA LK","category_id":"00000000-0000-0000-0000-0000000fa8c1","amount":1950,"fingerprint":"sbal1-0-x"}]}'::jsonb)$$,
  'saved as a Grocery expense');
select is((select l.destiny from transaction_line l join money_transaction t on t.id = l.transaction_id where t.source = 'sms'
            and t.household_id = '00000000-0000-0000-0000-0000000fa8aa'), 'expense', 'the alert''s line is the whole bill, not a pantry item');
select is((select destiny from transaction_line where fingerprint = 'bal1-0-a'), 'stock', 'a scanned bill''s Grocery line still goes to the pantry');
select throws_ok($$select rpc_line_link_product((select l.id from transaction_line l join money_transaction t on t.id = l.transaction_id
                     where t.source = 'sms' and t.household_id = '00000000-0000-0000-0000-0000000fa8aa'),
                   '00000000-0000-0000-0000-0000000fa8f1', 'stock')$$,
  '23514', null, 'no product can be linked to it');
select is((select count(*)::int from product_alias where household_id = '00000000-0000-0000-0000-0000000fa8aa'), 0,
  'and its shop name is not learned as a product name');

select * from finish();
rollback;
