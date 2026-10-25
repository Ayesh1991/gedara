-- Phase 9b.2 fix: money moved between your own accounts, booked as spending on one side and income on the
-- other, becomes one transfer with both alerts through rpc_sms_rebook (no new migration): both wrong
-- entries go, the balances stay right, and no income or spending is left behind.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000fe601', 'own-owner@test.local');
insert into household (id, name) values ('00000000-0000-0000-0000-0000000fe6aa', 'Own A');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fe6aa', '00000000-0000-0000-0000-0000000fe601', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fe6c1', '00000000-0000-0000-0000-0000000fe6aa', 'other', 'Other', 'expense'),
  ('00000000-0000-0000-0000-0000000fe6c2', '00000000-0000-0000-0000-0000000fe6aa', 'income', 'Income', 'expense');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fe6a1', '00000000-0000-0000-0000-0000000fe6aa', 'BOC Savings', 'bank', 'BOC', '319', null, 1000, '2026-10-01'),
  ('00000000-0000-0000-0000-0000000fe6a2', '00000000-0000-0000-0000-0000000fe6aa', 'BOC ··708', 'bank', 'BOC', '708', null, 300000, '2026-10-01');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fe601","role":"authenticated"}';

select is(rpc_sms_import('00000000-0000-0000-0000-0000000fe6aa', '[
  {"sender":"BOC","body":"Online Transfer Debit Rs 110000.00 From A/C No XXXXXXXXXX708. Balance available Rs 190000.00 - Thank you for banking with BOC",
   "received_at":"2026-10-21T03:30:00Z","fingerprint":"sown1","kind":"bank_debit","institution":"BOC","last_digits":"708","amount":110000,"balance_after":190000,
   "merchant_text":"Online Transfer Debit","occurred_on":"2026-10-21"},
  {"sender":"BOC","body":"Online Transfer Credit Rs 110000.00 To A/C No XXXXXXXXXX319. Balance available Rs 111000.00 - Thank you for banking with BOC",
   "received_at":"2026-10-21T03:31:00Z","fingerprint":"sown2","kind":"bank_credit","institution":"BOC","last_digits":"319","amount":110000,"balance_after":111000,
   "merchant_text":"Online Transfer Credit","occurred_on":"2026-10-21"}]'::jsonb) ->> 'stored', '2', 'both sides stored');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sown1')], '{"household_id":"00000000-0000-0000-0000-0000000fe6aa","type":"expense","account_id":"00000000-0000-0000-0000-0000000fe6a2","occurred_on":"2026-10-21","total":110000,"lines":[{"raw_name":"Online Transfer Debit","category_id":"00000000-0000-0000-0000-0000000fe6c1","amount":110000,"fingerprint":"sown1-0-x"}]}'::jsonb)$$, 'booked as spending');
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sown2')], '{"household_id":"00000000-0000-0000-0000-0000000fe6aa","type":"income","account_id":"00000000-0000-0000-0000-0000000fe6a1","occurred_on":"2026-10-21","total":110000,"lines":[{"raw_name":"Online Transfer Credit","category_id":"00000000-0000-0000-0000-0000000fe6c2","amount":110000,"fingerprint":"sown2-0-x"}]}'::jsonb)$$, 'and as income');

select lives_ok(format($$select rpc_sms_rebook('{"debit_sms":"%s","delete_tx":["%s","%s"],"transfer_id":null,"to_account_id":"00000000-0000-0000-0000-0000000fe6a1","payment_sms":"%s","total":110000,"fee":0,"fee_category_id":null}'::jsonb)$$,
  (select id from sms_message where fingerprint = 'sown1'), (select transaction_id from sms_message where fingerprint = 'sown1'),
  (select transaction_id from sms_message where fingerprint = 'sown2'), (select id from sms_message where fingerprint = 'sown2')),
  'Fix: one transfer instead');
select is((select string_agg(t.type, ',' order by t.type) || ' | ' ||
                  (select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000fe6a1') || ' / ' ||
                  (select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000fe6a2') || ' | linked ' ||
                  (select count(distinct transaction_id) from sms_message where fingerprint in ('sown1', 'sown2'))
             from money_transaction t where t.household_id = '00000000-0000-0000-0000-0000000fe6aa'),
  'transfer | 111000.00 / 190000.00 | linked 1', 'one transfer, both alerts on it, balances unchanged, no income or spending left');

select * from finish();
rollback;
