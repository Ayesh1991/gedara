-- Phase 9b.1: payees' confirmations (kind receipt) are stored; the OTP check knows the sender (Sampath's
-- references only from SAMPATHTXN, its closing line never frees a code); the payee map is the household's
-- own; "Check past bookings" rebooks a CEFT expense into the transfer it really was, in one step.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fe201', 'rcpt-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fe203', 'rcpt-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000ff201', 'rcpt-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fe2aa', 'Receipts A'),
  ('00000000-0000-0000-0000-0000000ff2bb', 'Receipts B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fe2aa', '00000000-0000-0000-0000-0000000fe201', 'owner'),
  ('00000000-0000-0000-0000-0000000fe2aa', '00000000-0000-0000-0000-0000000fe203', 'viewer'),
  ('00000000-0000-0000-0000-0000000ff2bb', '00000000-0000-0000-0000-0000000ff201', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fe0c1', '00000000-0000-0000-0000-0000000fe2aa', 'services', 'Services', 'expense'),
  ('00000000-0000-0000-0000-0000000ff0c1', '00000000-0000-0000-0000-0000000ff2bb', 'services', 'Services B', 'expense');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000fe0c2', '00000000-0000-0000-0000-0000000fe2aa', '00000000-0000-0000-0000-0000000fe0c1', 'Banking & fees'),
  ('00000000-0000-0000-0000-0000000fe0c3', '00000000-0000-0000-0000-0000000fe2aa', '00000000-0000-0000-0000-0000000fe0c1', 'Mobile & telephone');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fe0a1', '00000000-0000-0000-0000-0000000fe2aa', 'BOC Savings', 'bank', 'BOC', '319', null, 100000, '2026-08-01'),
  ('00000000-0000-0000-0000-0000000fe0a2', '00000000-0000-0000-0000-0000000fe2aa', 'Seylan Card', 'credit_card', 'Seylan', '6029', 100000, -30000, '2026-08-01'),
  ('00000000-0000-0000-0000-0000000fe0a3', '00000000-0000-0000-0000-0000000fe2aa', 'Sampath Savings', 'bank', 'Sampath', '1110', null, 0, '2026-08-01');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fe201","role":"authenticated"}';

-- ── Receipts and the sender-aware OTP check ──────────────────────────────────
select is(rpc_sms_import('00000000-0000-0000-0000-0000000fe2aa', '[
  {"sender":"SLTBILL","body":"Your bill payment Rs.3400.00 has been received to account number 0034847977 (94113602084) on 2026/09/22:02:34:51 AM. Thank you.",
   "received_at":"2026-09-21T21:05:00Z","fingerprint":"src1","parser":"slt.bill","parser_version":3,"kind":"receipt","institution":"SLT",
   "amount":3400,"merchant_text":"SLT bill","occurred_on":"2026-09-22","occurred_at":"02:34:51"},
  {"sender":"SAMPATHTXN","body":"LKR 50.00 debited from AC **1110 for DORMANT_CHG_052026 04/05/2026 06:36:44 To Inq Call 0112303050 Get protected -Do not Share OTP",
   "received_at":"2026-08-04T01:07:00Z","fingerprint":"src2","parser":"sampath.account_debit","parser_version":3,"kind":"bank_debit",
   "institution":"Sampath","last_digits":"1110","amount":50,"merchant_text":"DORMANT CHG","occurred_on":"2026-08-04"},
  {"sender":"BOC","body":"LKR 50.00 debited from AC **1110 for DORMANT_CHG_052026 04/05/2026 06:36:44",
   "received_at":"2026-08-04T01:08:00Z","fingerprint":"src3","kind":"unknown","occurred_on":"2026-08-04"},
  {"sender":"SAMPATHTXN","body":"Your OTP is 482913 for the transfer. Get protected -Do not Share OTP",
   "received_at":"2026-08-04T01:09:00Z","fingerprint":"src4","kind":"unknown","occurred_on":"2026-08-04"}
  ]'::jsonb), '{"stored": 2, "duplicate": 0, "dropped": 2}'::jsonb,
  'a receipt and a Sampath account alert are stored; Sampath''s reference from BOC, and an OTP with Sampath''s closing line, are dropped');
select is((select kind || ' ' || merchant_text from sms_message where fingerprint = 'src1'), 'receipt SLT bill', 'the receipt is a receipt');
select is((select a.name from sms_message s join account a on a.id = s.account_id where s.fingerprint = 'src2'), 'Sampath Savings',
  'the Sampath account alert finds its account');
-- Star Points names the shop and time but no amount: a note, stored (migration 87); money still needs one
select is(rpc_sms_import('00000000-0000-0000-0000-0000000fe2aa', '[
  {"sender":"Star Points","body":"Dear Customer, you have earned 1.6 Star Points for your transaction at Cargills Rewards on 2026/10/20 21:10:25. Total Star Points balance is 205.35",
   "received_at":"2026-10-20T15:41:00Z","fingerprint":"src5","parser":"starpoints.shop","parser_version":3,"kind":"info","institution":"Star Points",
   "merchant_text":"Cargills","occurred_on":"2026-10-20","occurred_at":"21:10:25"}
  ]'::jsonb), '{"stored": 1, "duplicate": 0, "dropped": 0}'::jsonb, 'a Star Points shop note without an amount is stored');
select throws_ok($$select rpc_sms_import('00000000-0000-0000-0000-0000000fe2aa', '[
  {"sender":"BOC","body":"Online Transfer Debit","received_at":"2026-10-20T15:42:00Z","fingerprint":"src6","kind":"bank_debit","occurred_on":"2026-10-20"}
  ]'::jsonb)$$, '23514', null, 'a bank debit without an amount is still refused');

-- ── Payee map ─────────────────────────────────────────────────────────────────
select lives_ok($$select rpc_payee_category_save('00000000-0000-0000-0000-0000000fe2aa', 'Dialog plan', '00000000-0000-0000-0000-0000000fe0c3')$$,
  'owner says: Dialog plan → Mobile & telephone');
select is((select payee_norm from payee_category), 'dialog plan', 'stored normalised');
select throws_ok($$select rpc_payee_category_save('00000000-0000-0000-0000-0000000fe2aa', 'x', '00000000-0000-0000-0000-0000000ff0c1')$$,
  '23503', null, 'another household''s category is refused');
select throws_ok($$insert into payee_category (household_id, payee_norm, category_id)
  values ('00000000-0000-0000-0000-0000000fe2aa', 'y', '00000000-0000-0000-0000-0000000fe0c3')$$, '42501', null, 'written only through the RPC');

-- ── Check past bookings: a CEFT expense that is really a card payment ─────────
-- 25 Aug: BOC "CEFT Transfer Debit Rs 25025.00" was booked as a Banking & fees EXPENSE, and the Seylan
-- payment Rs 25,000 separately as a transfer — the same money counted twice.
select is(rpc_sms_import('00000000-0000-0000-0000-0000000fe2aa', '[
  {"sender":"BOC","body":"CEFT Transfer Debit Rs 25025.00 From A/C No XXXXXXXXXX319. Balance available Rs 74975.00 - Thank you for banking with BOC",
   "received_at":"2026-08-25T13:01:10Z","fingerprint":"srb1","kind":"bank_debit","institution":"BOC","last_digits":"319","amount":25025,
   "merchant_text":"CEFT Transfer Debit","occurred_on":"2026-08-25"},
  {"sender":"Seylan Bank","body":"Seylan Credit Card Services - Thank you for your payment of LKR 25,000.00 made to Card # ...6029 on 25/08/2026 06:30:18 PM. Avl bal 95,000.00",
   "received_at":"2026-08-25T13:00:30Z","fingerprint":"srb2","kind":"card_payment","institution":"Seylan","last_digits":"6029","amount":25000,
   "occurred_on":"2026-08-25"},
  {"sender":"BOC","body":"CEFT Transfer Debit Rs 5025.00 From A/C No XXXXXXXXXX319. Balance available Rs 69950.00 - Thank you for banking with BOC",
   "received_at":"2026-09-08T05:00:00Z","fingerprint":"srb3","kind":"bank_debit","institution":"BOC","last_digits":"319","amount":5025,
   "merchant_text":"CEFT Transfer Debit","occurred_on":"2026-09-08"},
  {"sender":"Seylan Bank","body":"Seylan Credit Card Services - Thank you for your payment of LKR 5,000.00 made to Card # ...6029 on 08/09/2026 10:30:18 AM. Avl bal 99,000.00",
   "received_at":"2026-09-08T05:01:00Z","fingerprint":"srb4","kind":"card_payment","institution":"Seylan","last_digits":"6029","amount":5000,
   "occurred_on":"2026-09-08"}]'::jsonb) ->> 'stored', '4', 'four alerts');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'srb1')], '{
  "household_id":"00000000-0000-0000-0000-0000000fe2aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fe0a1",
  "occurred_on":"2026-08-25","total":25025,
  "lines":[{"raw_name":"CEFT Transfer Debit","category_id":"00000000-0000-0000-0000-0000000fe0c2","amount":25025,"fingerprint":"srb1-0-x"}]}'::jsonb)$$,
  'the wrong booking: an expense of 25,025');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'srb2')], '{
  "household_id":"00000000-0000-0000-0000-0000000fe2aa","type":"transfer","account_id":"00000000-0000-0000-0000-0000000fe0a1",
  "to_account_id":"00000000-0000-0000-0000-0000000fe0a2","occurred_on":"2026-08-25","total":25000,"lines":[]}'::jsonb)$$,
  'and the card payment as a transfer');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000fe0a1'), 49975.00,
  'before: BOC lost 50,025 for one payment of 25,025');

select throws_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', (select id from sms_message where fingerprint = 'srb1'),
  'delete_tx', jsonb_build_array((select transaction_id from sms_message where fingerprint = 'srb1')),
  'transfer_id', (select transaction_id from sms_message where fingerprint = 'srb2'), 'total', 25000, 'fee', 30))$$,
  '23514', null, 'the debit must be the transfer plus its fee');
select throws_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', (select id from sms_message where fingerprint = 'srb1'),
  'delete_tx', jsonb_build_array((select transaction_id from sms_message where fingerprint = 'srb2')),
  'transfer_id', (select transaction_id from sms_message where fingerprint = 'srb2'), 'total', 25000, 'fee', 25))$$,
  '23514', null, 'only the expense these alerts were booked as can go (not the transfer)');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fe203","role":"authenticated"}';
select throws_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', (select id from sms_message where fingerprint = 'srb1'),
  'delete_tx', '[]'::jsonb, 'transfer_id', (select transaction_id from sms_message where fingerprint = 'srb2'), 'total', 25000, 'fee', 25))$$,
  '42501', null, 'a viewer cannot rebook');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000ff201","role":"authenticated"}';
select throws_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', '00000000-0000-0000-0000-000000000000', 'total', 1, 'fee', 0))$$,
  '42501', null, 'household B cannot rebook A''s alerts (it cannot even see them)');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fe201","role":"authenticated"}';
-- Fix 1: the transfer is already booked → the expense goes, the debit joins it, Rs 25 is its fee.
select lives_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', (select id from sms_message where fingerprint = 'srb1'),
  'delete_tx', jsonb_build_array((select transaction_id from sms_message where fingerprint = 'srb1')),
  'transfer_id', (select transaction_id from sms_message where fingerprint = 'srb2'), 'total', 25000, 'fee', 25,
  'fee_category_id', '00000000-0000-0000-0000-0000000fe0c2'))$$, 'owner fixes the 25,025');
select is((select count(distinct transaction_id)::int || ' ' || count(*)::int from sms_message where fingerprint in ('srb1', 'srb2')),
  '1 2', 'both alerts point at the one transfer');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000fe2aa' and type = 'expense'
            and total = 25025), 0, 'the 25,025 expense is gone');
select is((select f.total from money_transaction f join money_transaction t on t.id = f.related_id
            where t.id = (select transaction_id from sms_message where fingerprint = 'srb2')), 25.00, 'the Rs 25 is the transfer''s fee');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000fe0a1'), 74975.00,
  'after: BOC lost 25,025 once — what the bank said');

-- Fix 2: no transfer yet → one is made from the debit and the waiting card payment.
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'srb3')], '{
  "household_id":"00000000-0000-0000-0000-0000000fe2aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fe0a1",
  "occurred_on":"2026-09-08","total":5025,
  "lines":[{"raw_name":"CEFT Transfer Debit","category_id":"00000000-0000-0000-0000-0000000fe0c2","amount":5025,"fingerprint":"srb3-0-x"}]}'::jsonb)$$,
  'another wrong booking: an expense of 5,025');
select lives_ok($$select rpc_sms_rebook(jsonb_build_object('debit_sms', (select id from sms_message where fingerprint = 'srb3'),
  'delete_tx', jsonb_build_array((select transaction_id from sms_message where fingerprint = 'srb3')),
  'to_account_id', '00000000-0000-0000-0000-0000000fe0a2', 'payment_sms', (select id from sms_message where fingerprint = 'srb4'),
  'total', 5000, 'fee', 25, 'fee_category_id', '00000000-0000-0000-0000-0000000fe0c2'))$$, 'owner fixes the 5,025');
select is((select t.type || ' ' || t.total || ' ' || (select count(*) from sms_message s where s.transaction_id = t.id)
             from money_transaction t where t.id = (select transaction_id from sms_message where fingerprint = 'srb3')),
  'transfer 5000.00 2', 'a transfer of 5,000 with both alerts');
select is((select available from v_account_balance where account_id = '00000000-0000-0000-0000-0000000fe0a2'), 100000.00,
  'the Seylan card got both payments (30,000 owed − 25,000 − 5,000)');

-- Receipts and payee map stay in household A
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000ff201","role":"authenticated"}';
select is((select count(*)::int from payee_category) + (select count(*)::int from sms_message where kind = 'receipt'), 0,
  'household B sees none of A''s receipts or payee map');

select * from finish();
rollback;
