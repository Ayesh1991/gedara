-- Phase 9b.2 fix (migration 91): rpc_sms_drop_duplicate removes an entry made only from copies of an alert
-- (same sender, kind, amount, balance) and marks the copies seen — and nothing else: not an entry that also
-- holds a real alert, not when the "copy" differs, not for a viewer or another household.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fd101', 'dup-owner@test.local'),
  ('00000000-0000-0000-0000-0000000fd103', 'dup-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000fd201', 'dup-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fd1aa', 'Dup A'),
  ('00000000-0000-0000-0000-0000000fd2bb', 'Dup B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd101', 'owner'),
  ('00000000-0000-0000-0000-0000000fd1aa', '00000000-0000-0000-0000-0000000fd103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fd2bb', '00000000-0000-0000-0000-0000000fd201', 'owner');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fd1a1', '00000000-0000-0000-0000-0000000fd1aa', 'BOC ··708', 'bank', 'BOC', '708', null, 100000, '2026-09-01'),
  ('00000000-0000-0000-0000-0000000fd1a2', '00000000-0000-0000-0000-0000000fd1aa', 'Sampath Card', 'credit_card', 'Sampath', '6577', 300000, 0, '2026-09-01');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';

-- Sampath sent the card payment twice (same balance); each copy became its own transfer
select is(rpc_sms_import('00000000-0000-0000-0000-0000000fd1aa', '[
  {"sender":"SAMPCCTXN","body":"Cr Crd no..**6577 Credited LKR 25,000.00 for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 50,328.70 Enq Call 0112300604 - Sampath Bank 02-OCT",
   "received_at":"2026-10-01T19:42:00Z","fingerprint":"sdup1","kind":"card_payment","institution":"Sampath","last_digits":"6577","amount":25000,"balance_after":50328.70,"occurred_on":"2026-10-02"},
  {"sender":"SAMPCCTXN","body":"Cr Crd no..**6577 Credited LKR 25,000.00 for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 50,328.70 Enq Call 0112300604 - Sampath Bank 02-OCT ",
   "received_at":"2026-10-03T19:42:26Z","fingerprint":"sdup2","kind":"card_payment","institution":"Sampath","last_digits":"6577","amount":25000,"balance_after":50328.70,"occurred_on":"2026-10-02"},
  {"sender":"SAMPCCTXN","body":"Cr Crd no..**6577 Credited LKR 25,000.00 for PAYMENT RECEIVED - CEFT (BOC) Avl Bal LKR 75,328.70 Enq Call 0112300604 - Sampath Bank 03-OCT",
   "received_at":"2026-10-03T19:50:00Z","fingerprint":"sdup3","kind":"card_payment","institution":"Sampath","last_digits":"6577","amount":25000,"balance_after":75328.70,"occurred_on":"2026-10-03"}
  ]'::jsonb) ->> 'stored', '3', 'three alerts: the payment, its copy, and a real second payment');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sdup1')], '{"household_id":"00000000-0000-0000-0000-0000000fd1aa","type":"transfer","account_id":"00000000-0000-0000-0000-0000000fd1a1","to_account_id":"00000000-0000-0000-0000-0000000fd1a2","occurred_on":"2026-10-02","total":25000,"lines":[]}'::jsonb)$$, 'the payment booked');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sdup2')], '{"household_id":"00000000-0000-0000-0000-0000000fd1aa","type":"transfer","account_id":"00000000-0000-0000-0000-0000000fd1a1","to_account_id":"00000000-0000-0000-0000-0000000fd1a2","occurred_on":"2026-10-03","total":25000,"lines":[]}'::jsonb)$$, 'and its copy, again (the mistake)');

-- (remembered while visible: another household can't even see these ids)
do $$ begin
  perform set_config('dup.keep', (select id::text from public.sms_message where fingerprint = 'sdup1'), true);
  perform set_config('dup.copy', (select id::text from public.sms_message where fingerprint = 'sdup2'), true);
  perform set_config('dup.tx', (select transaction_id::text from public.sms_message where fingerprint = 'sdup2'), true);
end $$;
select throws_ok(format($$select rpc_sms_drop_duplicate('{"keep_sms":["%s"],"drop_sms":["%s"],"delete_tx":null}'::jsonb)$$,
  (select id from sms_message where fingerprint = 'sdup1'), (select id from sms_message where fingerprint = 'sdup3')),
  '23514', null, 'a real second payment (another balance) is not a copy');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd103","role":"authenticated"}';
select throws_ok(format($$select rpc_sms_drop_duplicate('{"keep_sms":["%s"],"drop_sms":["%s"],"delete_tx":"%s"}'::jsonb)$$,
  (select id from sms_message where fingerprint = 'sdup1'), (select id from sms_message where fingerprint = 'sdup2'),
  (select transaction_id from sms_message where fingerprint = 'sdup2')), '42501', null, 'a viewer cannot');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd201","role":"authenticated"}';
select throws_ok(format($$select rpc_sms_drop_duplicate('{"keep_sms":["%s"],"drop_sms":["%s"],"delete_tx":"%s"}'::jsonb)$$,
  current_setting('dup.keep'), current_setting('dup.copy'), current_setting('dup.tx')), '42501', null, 'nor another household');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fd101","role":"authenticated"}';
select lives_ok(format($$select rpc_sms_drop_duplicate('{"keep_sms":["%s"],"drop_sms":["%s"],"delete_tx":"%s"}'::jsonb)$$,
  (select id from sms_message where fingerprint = 'sdup1'), (select id from sms_message where fingerprint = 'sdup2'),
  (select transaction_id from sms_message where fingerprint = 'sdup2')), 'the owner removes the copy''s entry');
select is((select count(*)::int || ' transfer, copy seen=' || bool_and(s.ignored)::text
             from money_transaction t, sms_message s
            where t.household_id = '00000000-0000-0000-0000-0000000fd1aa' and t.type = 'transfer' and s.fingerprint = 'sdup2'),
  '1 transfer, copy seen=true', 'one transfer is left, and the copy is marked seen');

select * from finish();
rollback;
