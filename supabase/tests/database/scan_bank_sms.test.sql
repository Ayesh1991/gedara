-- Phase 7c: bank SMS screenshot files. The scan inbox takes doc_type 'bank_sms'; its status is
-- "imported" once rpc_scan_file_done marks it (and back); only bank SMS files are marked this way;
-- another household can't see or mark my file; a viewer can't mark; anon can't call it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7601', 'p7c-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7603', 'p7c-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7701', 'p7c-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f76aa', 'SMS shots A'),
  ('00000000-0000-0000-0000-0000000f77bb', 'SMS shots B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f76aa', '00000000-0000-0000-0000-0000000f7601', 'owner'),
  ('00000000-0000-0000-0000-0000000f76aa', '00000000-0000-0000-0000-0000000f7603', 'viewer'),
  ('00000000-0000-0000-0000-0000000f77bb', '00000000-0000-0000-0000-0000000f7701', 'owner');
insert into scan_file (id, household_id, drive_file_id, name, mime, modified_at, doc_type, payload) values
  ('00000000-0000-0000-0000-00000000f761', '00000000-0000-0000-0000-0000000f76aa', 'smsfileAAAAAA', 'sms_2026-09-27_boc.json',
   'application/json', now(), 'bank_sms',
   '{"doc_type":"bank_sms","messages":[{"sender":"BOC","body":"ATM Withdrawal Rs 10000.00","time":"13:11"}]}'),
  ('00000000-0000-0000-0000-00000000f762', '00000000-0000-0000-0000-0000000f76aa', 'billfileAAAAAA', 'bill.json',
   'application/json', now(), 'bill', '[]');

create function pg_temp.status(p uuid) returns text language sql stable security definer as
  $$ select status from public.v_scan_file where id = p $$;

select throws_ok($$insert into scan_file (household_id, drive_file_id, name, mime, modified_at, doc_type, payload)
  values ('00000000-0000-0000-0000-0000000f76aa', 'posterAAAAAAAA', 'x', 'application/json', now(), 'poster', '{}')$$,
  '23514', null, 'unknown document kinds are still refused');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7601","role":"authenticated"}';
select is((select status from v_scan_file where id = '00000000-0000-0000-0000-00000000f761'), 'waiting', 'a new bank SMS file waits');
select lives_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f761')$$, 'owner marks its alerts added');
select is((select status from v_scan_file where id = '00000000-0000-0000-0000-00000000f761'), 'imported', '… then it counts as imported');
select is((select imported_at is not null from v_scan_file where id = '00000000-0000-0000-0000-00000000f761'), true, '… with the time');
select lives_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f761', false)$$, 'the mark can be taken back');
select is((select status from v_scan_file where id = '00000000-0000-0000-0000-00000000f761'), 'waiting', '… and it waits again');
select throws_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f762')$$, '23514', null,
  'bills are not marked this way (they count their imported bills)');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7701","role":"authenticated"}';
select is((select count(*)::int from v_scan_file), 0, 'B sees none of A''s files');
select throws_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f761')$$, '23503', null, 'B can''t mark A''s file');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7603","role":"authenticated"}';
select throws_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f761')$$, '42501', null, 'a viewer can''t mark');

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select rpc_scan_file_done('00000000-0000-0000-0000-00000000f761')$$, '42501', null, 'anon can''t call it');

select * from finish();
rollback;
