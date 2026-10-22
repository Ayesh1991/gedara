-- Phase 9a: alerts follow parser + account changes (rpc_sms_reparse, account trigger), shared
-- matching memories (merchant_memory, line_memory, rpc_memory_learn), household isolation.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fb101', 'mem-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fb103', 'mem-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fc101', 'mem-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fb1aa', 'Mem A'),
  ('00000000-0000-0000-0000-0000000fc1bb', 'Mem B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-0000000fb101', 'owner'),
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-0000000fb103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fc1bb', '00000000-0000-0000-0000-0000000fc101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-0000000fb0c1', '00000000-0000-0000-0000-0000000fb1aa', 'transport', 'Transport', 'expense'),
  ('00000000-0000-0000-0000-0000000fc0c1', '00000000-0000-0000-0000-0000000fc1bb', 'transport', 'Transport', 'expense');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000fb0a1', '00000000-0000-0000-0000-0000000fb1aa', 'BOC Savings', 'bank', 'BOC', '319', null, 0, '2026-08-01'),
  ('00000000-0000-0000-0000-0000000fb0a2', '00000000-0000-0000-0000-0000000fb1aa', 'BOC Card', 'credit_card', 'BOC', '8873', 250000, 0, '2026-08-01'),
  ('00000000-0000-0000-0000-0000000fc0a1', '00000000-0000-0000-0000-0000000fc1bb', 'Cash', 'cash', null, null, null, 0, null);
-- Alerts as v1 stored them: a BOC card payment read as "unknown" with the bank prefix as digits, and
-- three debits from an account Gedara doesn't know yet (..708), one already ignored by a person.
insert into sms_message (id, household_id, channel, sender, received_at, body, fingerprint, parser, parser_version,
                         kind, institution, last_digits, amount, occurred_on, ignored) values
  ('00000000-0000-0000-0000-0000000fb051', '00000000-0000-0000-0000-0000000fb1aa', 'backup', 'BOC', '2026-10-14T18:57:18Z',
   'Dear Customer, Thank you for payment of LKR 190354.70 on 14/10/2026 for Credit Card no. 5524 **** **** 8873. Balance Available LKR 250000.00n',
   'smem1', null, 1, 'unknown', 'BOC', '5524', 190354.70, '2026-10-15', false),
  ('00000000-0000-0000-0000-0000000fb052', '00000000-0000-0000-0000-0000000fb1aa', 'backup', 'BOC', '2026-10-14T17:40:30Z',
   'Online Transfer Debit Rs 190354.70 From A/C No XXXXXXXXXX708. Balance available Rs 1809645.30 - Thank you for banking with BOC',
   'smem2', 'boc.account_bank_debit', 1, 'bank_debit', 'BOC', '708', 190354.70, '2026-10-14', false),
  ('00000000-0000-0000-0000-0000000fb053', '00000000-0000-0000-0000-0000000fb1aa', 'backup', 'BOC', '2026-10-15T07:00:00Z',
   'Online Transfer Debit Rs 1000.00 From A/C No XXXXXXXXXX708. Balance available Rs 1808645.30 - Thank you for banking with BOC',
   'smem3', 'boc.account_bank_debit', 1, 'bank_debit', 'BOC', '708', 1000.00, '2026-10-15', true),
  ('00000000-0000-0000-0000-0000000fb054', '00000000-0000-0000-0000-0000000fb1aa', 'backup', 'BOC', '2026-06-20T04:00:00Z',
   'Exclusive for BOC Flex & Dialog Users! Get 50% Bonus Reload. Offer valid only on 26th June 2026. Rs.500',
   'smem4', null, 1, 'unknown', 'BOC', null, 500, '2026-06-20', false);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';

-- ── Re-parse ──────────────────────────────────────────────────────────────────
select is(rpc_sms_reparse('00000000-0000-0000-0000-0000000fb1aa', '[
  {"id":"00000000-0000-0000-0000-0000000fb051","parser":"boc.card_payment","parser_version":2,"kind":"card_payment",
   "institution":"BOC","last_digits":"8873","amount":190354.70,"currency":"LKR","balance_after":250000.00,
   "merchant_text":"Payment received","bank_txn_id":null,"occurred_on":"2026-10-14","occurred_at":null},
  {"id":"00000000-0000-0000-0000-0000000fb054","parser_version":2,"drop":"promo"},
  {"id":"00000000-0000-0000-0000-0000000fb052","parser":"x","parser_version":1,"kind":"info"}
  ]'::jsonb), '{"updated": 1, "ignored": 1, "removed": 0, "skipped": 1}'::jsonb,
  'one alert re-parsed, a promotion set aside, an older version skipped');
select is((select s.kind || ' ' || s.last_digits || ' ' || a.name from sms_message s join account a on a.id = s.account_id
            where s.id = '00000000-0000-0000-0000-0000000fb051'),
  'card_payment 8873 BOC Card', 'the BOC card payment now has the card''s digits and account');
select is((select ignored and reviewed_by is not null from sms_message where id = '00000000-0000-0000-0000-0000000fb054'),
  true, 'the promotion is ignored, by the person who ran it');
select is((select kind from sms_message where id = '00000000-0000-0000-0000-0000000fb052'),
  'bank_debit', 'a version that isn''t newer changes nothing');
select is(rpc_sms_reparse('00000000-0000-0000-0000-0000000fb1aa', '[
  {"id":"00000000-0000-0000-0000-0000000fb051","parser":"boc.card_payment","parser_version":2,"kind":"info"}]'::jsonb) ->> 'skipped',
  '1', 'the same version twice is skipped');

-- An OTP that slipped into storage is removed the moment it is looked at again.
reset role;
insert into sms_message (id, household_id, channel, sender, received_at, body, fingerprint, parser_version, kind, occurred_on)
values ('00000000-0000-0000-0000-0000000fb055', '00000000-0000-0000-0000-0000000fb1aa', 'backup', 'BOC',
        '2026-10-01T04:00:00Z', 'Rs 5,000.00 transfer to A/C XXXX319 requested. 552901', 'smem5', 1, 'unknown', '2026-10-01');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';
select is(rpc_sms_reparse('00000000-0000-0000-0000-0000000fb1aa', '[
  {"id":"00000000-0000-0000-0000-0000000fb055","parser_version":2,"kind":"unknown"}]'::jsonb) ->> 'removed',
  '1', 'a stored text that looks like a code is deleted, whatever the caller sends');
select is((select count(*)::int from sms_message where id = '00000000-0000-0000-0000-0000000fb055'), 0, 'it is gone');

-- ── A new account picks up its waiting alerts ─────────────────────────────────
select is((select count(*)::int from sms_message where last_digits = '708' and account_id is null), 2,
  'before: the ..708 alerts have no account');
select lives_ok($$insert into account (household_id, name, kind, institution, last4, opening_balance, opening_on)
  values ('00000000-0000-0000-0000-0000000fb1aa', 'BOC ..708', 'bank', 'BOC', '708', 0, '2026-10-14')$$,
  'owner adds BOC ..708');
select is((select count(*)::int from sms_message s join account a on a.id = s.account_id
            where s.last_digits = '708' and a.name = 'BOC ..708'), 1,
  'the waiting ..708 alert now belongs to it');
select is((select account_id is null from sms_message where id = '00000000-0000-0000-0000-0000000fb053'), true,
  'an alert a person already ignored keeps what it had');

-- ── Memories ──────────────────────────────────────────────────────────────────
select is(rpc_memory_learn('00000000-0000-0000-0000-0000000fb1aa', '[
  {"kind":"merchant","text":"ETC top-up","category_id":"00000000-0000-0000-0000-0000000fb0c1"},
  {"kind":"merchant","text":"  CARGILLS - RAJAGIRIYA ","account_id":"00000000-0000-0000-0000-0000000fb0a2"},
  {"kind":"line","text":"Highway Toll","category_id":"00000000-0000-0000-0000-0000000fb0c1"},
  {"kind":"merchant","text":"nothing to learn"}]'::jsonb), 3, 'three memories learned, an empty one skipped');
select is((select merchant_norm from merchant_memory where account_id is not null), 'cargills rajagiriya',
  'keys are normalised like bill names');
select lives_ok($$select rpc_memory_learn('00000000-0000-0000-0000-0000000fb1aa',
  '[{"kind":"merchant","text":"ETC TOP UP","account_id":"00000000-0000-0000-0000-0000000fb0a1"}]'::jsonb)$$,
  'the same shop again');
select is((select hits || ' ' || (category_id is not null) || ' ' || (account_id is not null) from merchant_memory
            where merchant_norm = 'etc top up'), '2 true true', 'hits counted; the category is kept, the account added');
select throws_ok($$select rpc_memory_learn('00000000-0000-0000-0000-0000000fb1aa',
  '[{"kind":"line","text":"x","category_id":"00000000-0000-0000-0000-0000000fc0c1"}]'::jsonb)$$,
  '23503', null, 'another household''s category is refused');
select throws_ok($$insert into merchant_memory (household_id, merchant_norm, category_id)
  values ('00000000-0000-0000-0000-0000000fb1aa', 'x', '00000000-0000-0000-0000-0000000fb0c1')$$,
  '42501', null, 'memories are written only through the RPC');
select lives_ok($$delete from line_memory where name_norm = 'highway toll'$$, 'owner can forget a memory');
select is((select count(*)::int from line_memory), 0, 'forgotten');

-- ── Viewer and the other household ───────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb103","role":"authenticated"}';
select is((select count(*)::int from merchant_memory), 2, 'a viewer can read the household''s memories');
select throws_ok($$select rpc_memory_learn('00000000-0000-0000-0000-0000000fb1aa',
  '[{"kind":"merchant","text":"x","category_id":"00000000-0000-0000-0000-0000000fb0c1"}]'::jsonb)$$,
  '42501', null, 'a viewer cannot teach');
select throws_ok($$select rpc_sms_reparse('00000000-0000-0000-0000-0000000fb1aa', '[]'::jsonb)$$,
  '42501', null, 'a viewer cannot re-parse');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fc101","role":"authenticated"}';
select is((select count(*)::int from merchant_memory) + (select count(*)::int from line_memory), 0,
  'household B sees none of A''s memories');
select throws_ok($$select rpc_sms_reparse('00000000-0000-0000-0000-0000000fb1aa', '[]'::jsonb)$$,
  '42501', null, 'household B cannot re-parse A''s alerts');
select is(rpc_sms_reparse('00000000-0000-0000-0000-0000000fc1bb', '[
  {"id":"00000000-0000-0000-0000-0000000fb052","parser":"x","parser_version":9,"kind":"info"}]'::jsonb) ->> 'skipped',
  '1', 'B naming A''s alert in its own household changes nothing');
select is(rpc_memory_learn('00000000-0000-0000-0000-0000000fc1bb', '[]'::jsonb), 0, 'B can teach its own household');

select * from finish();
rollback;
