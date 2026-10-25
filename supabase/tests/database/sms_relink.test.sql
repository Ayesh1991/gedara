-- Phase 9b.2 fix (migrations 92–93): rpc_sms_relink — a Tap & Pay alert saved as its own expense while its
-- scanned bill waits in "to be matched" (or already sits on the same account): the alert's entry goes, the
-- alert links to the bill, the bill moves to the wallet. Refused for a different amount, a bill already
-- linked to an alert, a viewer, another household.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fc101', 'relink-owner@test.local'),
  ('00000000-0000-0000-0000-0000000fc103', 'relink-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000fc201', 'relink-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fc1aa', 'Relink A'),
  ('00000000-0000-0000-0000-0000000fc2bb', 'Relink B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc101', 'owner'),
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fc2bb', '00000000-0000-0000-0000-0000000fc201', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fc1c1', '00000000-0000-0000-0000-0000000fc1aa', 'other', 'Other', 'expense');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on, is_suspense) values
  ('00000000-0000-0000-0000-0000000fc1a1', '00000000-0000-0000-0000-0000000fc1aa', 'BOC Flex', 'wallet', 'BOC Flex', '3399', null, 20000, '2026-10-01', false),
  ('00000000-0000-0000-0000-0000000fc1a2', '00000000-0000-0000-0000-0000000fc1aa', 'Card — to be matched', 'credit_card', null, null, null, 0, '2026-10-01', true);
-- the scanned bills (fixtures): one waiting in "to be matched", one already moved to the wallet by hand
insert into money_transaction (id, household_id, type, account_id, occurred_on, total, source, fingerprint) values
  ('00000000-0000-0000-0000-0000000fc1e1', '00000000-0000-0000-0000-0000000fc1aa', 'expense', '00000000-0000-0000-0000-0000000fc1a2', '2026-10-25', 5066.26, 'scan', 'brl1'),
  ('00000000-0000-0000-0000-0000000fc1e2', '00000000-0000-0000-0000-0000000fc1aa', 'expense', '00000000-0000-0000-0000-0000000fc1a1', '2026-10-21', 2252, 'scan', 'brl2');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc1e1', 0, 'CARGILLS', '00000000-0000-0000-0000-0000000fc1c1', 5066.26, 'brl1-0-a'),
  ('00000000-0000-0000-0000-0000000fc1aa', '00000000-0000-0000-0000-0000000fc1e2', 0, 'GUNASEKARA', '00000000-0000-0000-0000-0000000fc1c1', 2252, 'brl2-0-a');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc101","role":"authenticated"}';

select is(rpc_sms_import('00000000-0000-0000-0000-0000000fc1aa', '[
  {"sender":"BOCONLINE","body":"Your Tap & Pay transaction of LKR 5066.26 from XXXX3399 at CARGILLS - RAJAGIRIYA was successful. Ref: VC_A1B2C3D4",
   "received_at":"2026-10-25T13:40:00Z","fingerprint":"srl1","parser":"boconline.tap_pay","kind":"bank_debit","institution":"BOC Flex","last_digits":"3399",
   "amount":5066.26,"merchant_text":"CARGILLS - RAJAGIRIYA","bank_txn_id":"VC_A1B2C3D4","occurred_on":"2026-10-25"},
  {"sender":"BOCONLINE","body":"Your Tap & Pay transaction of LKR 2252.00 from XXXX3399 at GUNASEKARA & COMPANY was successful. Ref: VC_7760QQS8",
   "received_at":"2026-10-21T08:12:00Z","fingerprint":"srl2","parser":"boconline.tap_pay","kind":"bank_debit","institution":"BOC Flex","last_digits":"3399",
   "amount":2252,"merchant_text":"GUNASEKARA & COMPANY","bank_txn_id":"VC_7760QQS8","occurred_on":"2026-10-21"}]'::jsonb) ->> 'stored', '2', 'two Tap & Pay alerts');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'srl1')], '{"household_id":"00000000-0000-0000-0000-0000000fc1aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fc1a1","occurred_on":"2026-10-25","total":5066.26,"lines":[{"raw_name":"CARGILLS","category_id":"00000000-0000-0000-0000-0000000fc1c1","amount":5066.26,"fingerprint":"srl1-0-x"}]}'::jsonb)$$, 'saved from the alert (the mistake)');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'srl2')], '{"household_id":"00000000-0000-0000-0000-0000000fc1aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fc1a1","occurred_on":"2026-10-21","total":2252,"lines":[{"raw_name":"GUNASEKARA","category_id":"00000000-0000-0000-0000-0000000fc1c1","amount":2252,"fingerprint":"srl2-0-x"}]}'::jsonb)$$, 'and the other one');

do $$ begin
  perform set_config('rl.s1', (select id::text from public.sms_message where fingerprint = 'srl1'), true);
  perform set_config('rl.t1', (select transaction_id::text from public.sms_message where fingerprint = 'srl1'), true);
  perform set_config('rl.s2', (select id::text from public.sms_message where fingerprint = 'srl2'), true);
  perform set_config('rl.t2', (select transaction_id::text from public.sms_message where fingerprint = 'srl2'), true);
end $$;

select throws_ok(format($$select rpc_sms_relink('{"sms_ids":["%s"],"delete_tx":"%s","bill_tx":"00000000-0000-0000-0000-0000000fc1e2"}'::jsonb)$$,
  current_setting('rl.s1'), current_setting('rl.t1')), '23514', null, 'a bill of another amount is not the same purchase');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc103","role":"authenticated"}';
select throws_ok(format($$select rpc_sms_relink('{"sms_ids":["%s"],"delete_tx":"%s","bill_tx":"00000000-0000-0000-0000-0000000fc1e1"}'::jsonb)$$,
  current_setting('rl.s1'), current_setting('rl.t1')), '42501', null, 'a viewer cannot');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc201","role":"authenticated"}';
select throws_ok(format($$select rpc_sms_relink('{"sms_ids":["%s"],"delete_tx":"%s","bill_tx":"00000000-0000-0000-0000-0000000fc1e1"}'::jsonb)$$,
  current_setting('rl.s1'), current_setting('rl.t1')), '42501', null, 'nor another household');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc101","role":"authenticated"}';
select lives_ok(format($$select rpc_sms_relink('{"sms_ids":["%s"],"delete_tx":"%s","bill_tx":"00000000-0000-0000-0000-0000000fc1e1"}'::jsonb)$$,
  current_setting('rl.s1'), current_setting('rl.t1')) || '; ' ||
  format($$select rpc_sms_relink('{"sms_ids":["%s"],"delete_tx":"%s","bill_tx":"00000000-0000-0000-0000-0000000fc1e2"}'::jsonb)$$,
  current_setting('rl.s2'), current_setting('rl.t2')), 'the owner fixes both');
select is((select string_agg(t.source || ':' || t.total || ':' || (t.account_id = '00000000-0000-0000-0000-0000000fc1a1') ||
                             ':' || (select count(*) from sms_message s where s.transaction_id = t.id), ',' order by t.total)
             from money_transaction t where t.household_id = '00000000-0000-0000-0000-0000000fc1aa'),
  'scan:2252.00:true:1,scan:5066.26:true:1', 'only the two bills are left, both on the wallet, each linked to its alert');

select * from finish();
rollback;
