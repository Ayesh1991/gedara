-- Bank-SMS inbox: devices (owner only, token never readable), ingest (device path = service_role
-- only; SMS-backup path = can_write), dedupe, OTPs never stored, account resolution, review RPCs
-- (link moves suspense bills, post = transfer + fee, ignore, unlink), household isolation.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(41);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f9101', 'sms-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9102', 'sms-member-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9103', 'sms-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa101', 'sms-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f19aa', 'Sms A'),
  ('00000000-0000-0000-0000-0000000f1abb', 'Sms B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f19aa', '00000000-0000-0000-0000-0000000f9101', 'owner'),
  ('00000000-0000-0000-0000-0000000f19aa', '00000000-0000-0000-0000-0000000f9102', 'member'),
  ('00000000-0000-0000-0000-0000000f19aa', '00000000-0000-0000-0000-0000000f9103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f1abb', '00000000-0000-0000-0000-0000000fa101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000f19aa', 'services', 'Services', 'expense');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on, is_suspense) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000f19aa', 'BOC Savings', 'bank', 'BOC', '319', null, 100000, '2026-08-01', false),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000f19aa', 'BOC Card', 'credit_card', 'BOC', '8873', 250000, 0, '2026-08-01', false),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f19aa', 'Seylan Card', 'credit_card', 'Seylan', '6029', 100000, -30000, '2026-08-01', false),
  ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-0000000f19aa', 'Card — to be matched', 'credit_card', null, null, null, 0, null, true),
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-0000000f1abb', 'Cash', 'cash', null, null, null, 0, null, false);
-- B's own transaction (to try linking A's alerts to it).
insert into money_transaction (id, household_id, type, account_id, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-0000000f1abb', 'adjustment',
   '00000000-0000-0000-0000-00000000c101', '2026-08-02', 1, 'mbtx');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9101","role":"authenticated"}';

select lives_ok($q$do $d$ begin
  perform set_config('gedara.token',
    rpc_sms_device_create('00000000-0000-0000-0000-0000000f19aa', 'Didula''s phone') ->> 'token', true);
end $d$$q$, 'owner adds an SMS forwarder device');
select is((select length(current_setting('gedara.token')) || ' ' || (right(current_setting('gedara.token'), 4) = token_hint)
             from sms_device where household_id = '00000000-0000-0000-0000-0000000f19aa'),
  '43 true', 'the token is 43 url-safe characters and only its last 4 are kept');
select throws_ok($$select token_hash from sms_device$$, '42501', null, 'nobody can read a device''s token hash');

select is(rpc_sms_import('00000000-0000-0000-0000-0000000f19aa', '[
  {"sender":"BOC","body":"CEFT Transfer Debit Rs 25025.00 From A/C No XXXXXXXXXX319. Balance available Rs 74975.00 - Thank you for banking with BOC",
   "received_at":"2026-08-25T13:01:10Z","fingerprint":"sa1","parser":"boc.transfer_debit","parser_version":1,
   "kind":"bank_debit","institution":"BOC","last_digits":"319","amount":25025.00,"balance_after":74975.00,
   "occurred_on":"2026-08-25","occurred_at":"18:31:10"},
  {"sender":"Seylan Bank","body":"Seylan Credit Card Services - Thank you for your payment of LKR 25,000.00 made to Card # ...6029 on 25/08/2026 06:30:18 PM. Avl bal 95,000.00",
   "received_at":"2026-08-25T13:00:30Z","fingerprint":"sa2","parser":"seylan.payment","parser_version":1,
   "kind":"card_payment","institution":"Seylan","last_digits":"6029","amount":25000.00,"balance_after":95000.00,
   "occurred_on":"2026-08-25","occurred_at":"18:30:18"},
  {"sender":"BOC","body":"Purchase. Transaction approved on your Credit Card 5524 **** **** 8873 for LKR 580.00 at CARGILLS. Balance Available LKR 249420.00",
   "received_at":"2026-08-22T14:51:00Z","fingerprint":"sa3","parser":"boc.card_purchase","parser_version":1,
   "kind":"card_charge","institution":"BOC","last_digits":"8873","amount":580.00,"balance_after":249420.00,
   "merchant_text":"CARGILLS","occurred_on":"2026-08-22","occurred_at":"20:21:00"},
  {"sender":"BOC","body":"Your OTP for the online transfer is 482913. Do not share it with anyone.",
   "received_at":"2026-08-25T13:00:00Z","fingerprint":"sa4","kind":"unknown","occurred_on":"2026-08-25"}
  ]'::jsonb), '{"stored": 3, "duplicate": 0, "dropped": 1}'::jsonb,
  'three alerts stored; the OTP is dropped even if it gets this far');
select is((select count(*)::int from sms_message where body ilike '%OTP%'), 0, 'no OTP text is ever stored');
select is(rpc_sms_import('00000000-0000-0000-0000-0000000f19aa', '[
  {"sender":"BOC","body":"CEFT Transfer Debit Rs 25025.00 From A/C No XXXXXXXXXX319. Balance available Rs 74975.00 - Thank you for banking with BOC",
   "received_at":"2026-08-25T13:01:14Z","fingerprint":"sa5","kind":"bank_debit","institution":"BOC","last_digits":"319",
   "amount":25025.00,"occurred_on":"2026-08-25"}]'::jsonb),
  '{"stored": 0, "duplicate": 1, "dropped": 0}'::jsonb,
  'the same alert from a backup file a few seconds apart is a duplicate');
select is((select string_agg(s.fingerprint || '→' || a.name, ', ' order by s.fingerprint)
             from sms_message s join account a on a.id = s.account_id),
  'sa1→BOC Savings, sa2→Seylan Card, sa3→BOC Card', 'institution + last digits pick the right account');

-- Link: a scanned bill waiting in "Card — to be matched" moves to the card the alert names.
select lives_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000f19aa', '[
  {"account_id":"00000000-0000-0000-0000-00000000c004","payee_text":"Cargills","occurred_on":"2026-08-22",
   "total":580,"source":"scan","fingerprint":"bsms1",
   "lines":[{"line_no":0,"raw_name":"Rice","amount":580,"fingerprint":"bsms1-0-a"}]}]'::jsonb)$$,
  'a card bill is imported into the suspense account');
select is(rpc_sms_link(array[(select id from sms_message where fingerprint = 'sa3')],
                       (select id from money_transaction where fingerprint = 'bsms1')),
  '{"moved": true}'::jsonb, 'linking the alert moves the bill');
select is((select a.name from money_transaction t join account a on a.id = t.account_id where t.fingerprint = 'bsms1'),
  'BOC Card', 'the bill now sits on the BOC card');
select throws_ok($$select rpc_sms_link(array[(select id from sms_message where fingerprint = 'sa3')],
                       (select id from money_transaction where fingerprint = 'bsms1'))$$,
  'GDLNK', null, 'an alert can''t be linked twice');

-- Post: BOC debit + Seylan payment → one transfer with its Rs 25 fee.
select lives_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sa1'),
                                            (select id from sms_message where fingerprint = 'sa2')], '{
  "household_id":"00000000-0000-0000-0000-0000000f19aa","type":"transfer",
  "account_id":"00000000-0000-0000-0000-00000000c001","to_account_id":"00000000-0000-0000-0000-00000000c003",
  "occurred_on":"2026-08-25","occurred_at":"18:30","total":25000,"lines":[],
  "fee":{"amount":25,"category_id":"00000000-0000-0000-0000-00000000f001"}}'::jsonb)$$,
  'owner turns the pair into a transfer');
select is((select source || ' ' || fingerprint from money_transaction where type = 'transfer'
             and household_id = '00000000-0000-0000-0000-0000000f19aa'),
  'sms sa2', 'source sms, fingerprint = the earliest alert''s');
select is((select count(*)::int from money_transaction where fingerprint = 'sa2~fee' and total = 25 and source = 'sms'), 1,
  'the CEFT fee is its own expense');
select is((select count(distinct transaction_id)::int || '/' || count(*)::int from sms_message
            where fingerprint in ('sa1', 'sa2')), '1/2', 'both alerts point at the transfer');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-00000000c001'), 74975.00,
  'BOC balance matches what the bank said (100000 − 25000 − 25)');
select is((select bank_reported = gedara_value from v_sms_balance_check where account_id = '00000000-0000-0000-0000-00000000c001'),
  true, 'Bank says = Gedara says for BOC');
select throws_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sa1')], '{
  "household_id":"00000000-0000-0000-0000-0000000f19aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000c001","occurred_on":"2026-08-25","total":1,
  "lines":[{"raw_name":"x","amount":1,"fingerprint":"sa1-0-x"}]}'::jsonb)$$,
  'GDLNK', null, 'a posted alert can''t be posted again');

-- Undo a post by deleting the transaction: its alerts are new again.
select lives_ok($$select rpc_delete_transaction((select id from money_transaction where fingerprint = 'sa2'))$$,
  'owner deletes the transfer');
select is((select count(*)::int from sms_message where fingerprint in ('sa1', 'sa2') and transaction_id is null), 2,
  'its alerts are back in the inbox');

-- Ignore / unlink.
select is(rpc_sms_ignore(array[(select id from sms_message where fingerprint = 'sa1')], true), 1, 'an alert is ignored');
select throws_ok($$select rpc_sms_post(array[(select id from sms_message where fingerprint = 'sa1')], '{
  "household_id":"00000000-0000-0000-0000-0000000f19aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000c001","occurred_on":"2026-08-25","total":1,
  "lines":[{"raw_name":"x","amount":1,"fingerprint":"sa1-0-x"}]}'::jsonb)$$,
  'GDLNK', null, 'an ignored alert can''t be posted');
select throws_ok($$select rpc_sms_ignore(array[(select id from sms_message where fingerprint = 'sa3')], true)$$,
  'GDLNK', null, 'a linked alert can''t be ignored');
select is(rpc_sms_unlink(array[(select id from sms_message where fingerprint = 'sa3')]), 1, 'a link is undone');

-- The manual path is unchanged.
select lives_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f19aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000c001","occurred_on":"2026-08-26","total":100,"fingerprint":"msms1",
  "lines":[{"raw_name":"Tea","amount":100,"fingerprint":"msms1-0-a"}]}'::jsonb)$$, 'manual save still works');
select is((select source from money_transaction where fingerprint = 'msms1'), 'manual', 'and is still marked manual');

-- Clients can't write the inbox or use the device path.
select throws_ok($$insert into sms_message (household_id, channel, sender, received_at, body, fingerprint, kind, occurred_on)
  values ('00000000-0000-0000-0000-0000000f19aa', 'backup', 'BOC', now(), 'x', 'sdirect', 'unknown', current_date)$$,
  '42501', null, 'no direct inserts into the inbox');
select throws_ok($$select rpc_sms_ingest_device('00', '[]'::jsonb)$$, '42501', null,
  'signed-in users can''t call the device ingest');

-- ── Member of A: reviews, but can't manage devices ────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9102","role":"authenticated"}';
select is(rpc_sms_ignore(array[(select id from sms_message where fingerprint = 'sa1')], false), 1, 'a member can un-ignore');
select throws_ok($$select rpc_sms_device_create('00000000-0000-0000-0000-0000000f19aa', 'x')$$,
  '42501', null, 'a member can''t add devices');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9103","role":"authenticated"}';
select throws_ok($$select rpc_sms_import('00000000-0000-0000-0000-0000000f19aa', '[]'::jsonb)$$,
  '42501', null, 'viewer can''t import alerts');
select throws_ok($$select rpc_sms_ignore(array[(select id from sms_message where fingerprint = 'sa1')], true)$$,
  '42501', null, 'viewer can''t review alerts');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa101","role":"authenticated"}';
select is((select count(*)::int from sms_message where household_id = '00000000-0000-0000-0000-0000000f19aa')
        + (select count(*)::int from sms_device where household_id = '00000000-0000-0000-0000-0000000f19aa')
        + (select count(*)::int from v_sms_balance_check where household_id = '00000000-0000-0000-0000-0000000f19aa'), 0,
  'B sees none of A''s alerts, devices or balance checks');
select throws_ok($$select rpc_sms_import('00000000-0000-0000-0000-0000000f19aa', '[]'::jsonb)$$,
  '42501', null, 'B can''t import into A');
select throws_ok($$select rpc_sms_device_revoke((select id from sms_device where household_id = '00000000-0000-0000-0000-0000000f19aa'))$$,
  '42501', null, 'B can''t revoke A''s device');

-- ── The Edge Function (service_role) ──────────────────────────────────────────
reset role;
set local role service_role;
select is(rpc_sms_ingest_device(encode(extensions.digest(convert_to(current_setting('gedara.token'), 'UTF8'), 'sha256'), 'hex'), '[
  {"sender":"Seylan Bank","body":"Seylan Card ...6029 debit Txn 10357428172 of LKR 550.00 done on 12/09/2026 01:09:29 PM at Google One 650-2530000 US. Avl bal 94,450.00",
   "received_at":"2026-09-12T07:39:40Z","fingerprint":"sb1","kind":"card_charge","institution":"Seylan","last_digits":"6029",
   "amount":550.00,"balance_after":94450.00,"merchant_text":"Google One","bank_txn_id":"10357428172",
   "occurred_on":"2026-09-12","occurred_at":"13:09:29"}]'::jsonb, 2, 'FLEX'),
  '{"stored": 1, "duplicate": 0, "dropped": 0}'::jsonb, 'the device path stores a forwarded alert');
select is((select message_count || ' ' || dropped_count || ' ' || last_rejected_sender || ' ' || (last_seen_at is not null)
             from sms_device where household_id = '00000000-0000-0000-0000-0000000f19aa'),
  '1 2 FLEX true', 'the device records what it sent and what was filtered');
select throws_ok($$select rpc_sms_ingest_device(repeat('0', 64), '[]'::jsonb)$$, '42501', null, 'an unknown token is refused');

-- ── Owner of A revokes; the token stops working ───────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9101","role":"authenticated"}';
select lives_ok($$select rpc_sms_device_revoke((select id from sms_device where household_id = '00000000-0000-0000-0000-0000000f19aa'))$$,
  'owner revokes the device');
reset role;
set local role service_role;
select throws_ok($$select rpc_sms_ingest_device(encode(extensions.digest(convert_to(current_setting('gedara.token'), 'UTF8'), 'sha256'), 'hex'), '[]'::jsonb)$$,
  '42501', null, 'a revoked device is refused');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from sms_message$$, '42501', null, 'anon can''t read the inbox');

select * from finish();
rollback;
