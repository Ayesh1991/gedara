-- Phase 9b.2 fix (migration 90): the accuracy report counts only the latest test — rows refreshed by it
-- (within 6 hours of the newest) — not items an earlier test checked that are no longer tested. Another
-- household's rows are never seen.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fb901', 'acc-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fb902', 'acc-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fb9aa', 'Accuracy A'),
  ('00000000-0000-0000-0000-0000000fb9bb', 'Accuracy B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fb9aa', '00000000-0000-0000-0000-0000000fb901', 'owner'),
  ('00000000-0000-0000-0000-0000000fb9bb', '00000000-0000-0000-0000-0000000fb902', 'owner');
-- A: today's test (3 alerts, 2 right) and one stale row from two days ago (wrong, no longer tested)
insert into match_eval (household_id, task, target_key, truth, ai, ai_correct, created_at) values
  ('00000000-0000-0000-0000-0000000fb9aa', 'sms_category', 'a1', '{}', '{"pattern": "ai1"}', true, now() - interval '20 minutes'),
  ('00000000-0000-0000-0000-0000000fb9aa', 'sms_category', 'a2', '{}', '{"pattern": "ai1"}', true, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000fb9aa', 'sms_category', 'a3', '{}', '{"pattern": "ai1"}', false, now()),
  ('00000000-0000-0000-0000-0000000fb9aa', 'sms_category', 'old', '{}', '{"pattern": "ai1+ai2"}', false, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000fb9bb', 'sms_category', 'b1', '{}', '{"pattern": "ai1"}', false, now() - interval '3 days');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb901","role":"authenticated"}';

select is((select n || '/' || ai_answered || '/' || ai_correct from v_match_accuracy where task = 'sms_category'), '3/3/2',
  'only the latest test counts (the stale row is left out)');
select is((select count(*)::int from v_match_accuracy_pattern where pattern = 'ai1+ai2'), 0, 'its pattern too');
select is((select count(*)::int from match_eval), 4, 'the stale row is kept, just not counted');
select is((select count(*)::int from v_match_accuracy where household_id = '00000000-0000-0000-0000-0000000fb9bb'), 0,
  'another household''s test is never seen');

select * from finish();
rollback;
