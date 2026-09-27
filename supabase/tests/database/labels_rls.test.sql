-- Phase 7b RLS: another household can't read my blank sheets, labels, their counts or my move log,
-- can't make sheets in my household, can't claim, detach or retire my codes (they look unknown), and
-- can't point my labels at their items or theirs at mine. Clients never write the tables directly;
-- a viewer reads only; anon sees nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(28);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7301', 'p7brls-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7303', 'p7brls-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7401', 'p7brls-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f73aa', 'Labels RLS A'),
  ('00000000-0000-0000-0000-0000000f74bb', 'Labels RLS B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f73aa', '00000000-0000-0000-0000-0000000f7301', 'owner'),
  ('00000000-0000-0000-0000-0000000f73aa', '00000000-0000-0000-0000-0000000f7303', 'viewer'),
  ('00000000-0000-0000-0000-0000000f74bb', '00000000-0000-0000-0000-0000000f7401', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c731', '00000000-0000-0000-0000-0000000f73aa', 'Box A'),
  ('00000000-0000-0000-0000-00000000c732', '00000000-0000-0000-0000-0000000f73aa', 'Shelf A'),
  ('00000000-0000-0000-0000-00000000c741', '00000000-0000-0000-0000-0000000f74bb', 'Box B');
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000a731', '00000000-0000-0000-0000-0000000f73aa', 'Drill A'),
  ('00000000-0000-0000-0000-00000000a741', '00000000-0000-0000-0000-0000000f74bb', 'Drill B');

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;
create function pg_temp.code(p_household uuid, p_slot integer) returns text language sql stable security definer as
  $$ select t.code from public.label_tag t where t.household_id = p_household and t.slot = p_slot $$;

set local role authenticated;

-- ── Owner A: a sheet, one label used, one move ────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7301","role":"authenticated"}';
insert into t_c values ('a', rpc_label_sheets('00000000-0000-0000-0000-0000000f73aa', 'a4', 1, 6));
insert into t_c values ('assign', rpc_tag_assign(pg_temp.code('00000000-0000-0000-0000-0000000f73aa', 0), 'asset',
  '00000000-0000-0000-0000-00000000a731'));
insert into t_c values ('move', rpc_move('00000000-0000-0000-0000-0000000003a1', 'asset',
  '00000000-0000-0000-0000-00000000a731', '00000000-0000-0000-0000-00000000c731'));
select is((select count(*)::int from label_tag), 6, 'owner sees A''s labels');
select throws_ok($$insert into label_sheet (household_id, sheet_no, format, slots) values ('00000000-0000-0000-0000-0000000f73aa', 99, 'a4', 1)$$,
  '42501', null, 'sheets are made by rpc_label_sheets only');
select throws_ok($$update label_tag set asset_id = null$$, '42501', null, 'labels are changed by their RPCs only');
select throws_ok($$delete from label_tag$$, '42501', null, 'labels are never deleted by clients');
select throws_ok($$insert into move_op (household_id, op_id, kind, item_id, result)
  values ('00000000-0000-0000-0000-0000000f73aa', gen_random_uuid(), 'asset', gen_random_uuid(), '{}')$$,
  '42501', null, 'the move log is written by rpc_move only');
select throws_ok(format($$select rpc_tag_assign(%L, 'asset', '00000000-0000-0000-0000-00000000a741')$$,
  pg_temp.code('00000000-0000-0000-0000-0000000f73aa', 1)), '23503', null, 'A can''t point a label at B''s thing');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a731', '00000000-0000-0000-0000-00000000c741')$$,
  '23503', null, 'A can''t put a thing into B''s box');

-- ── Owner B: nothing of A ─────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7401","role":"authenticated"}';
select is((select count(*)::int from label_tag), 0, 'B sees none of A''s labels');
select is((select count(*)::int from label_sheet) + (select count(*)::int from v_label_sheet), 0, 'B sees none of A''s sheets or counts');
select is((select count(*)::int from move_op), 0, 'B sees none of A''s moves');
select throws_ok($$select rpc_label_sheets('00000000-0000-0000-0000-0000000f73aa', 'a4', 1, 54)$$, '42501', null,
  'B can''t make sheets in A');
select throws_ok(format($$select rpc_tag_assign(%L, 'asset', '00000000-0000-0000-0000-00000000a741')$$,
  pg_temp.code('00000000-0000-0000-0000-0000000f73aa', 1)), '23503', null, 'B can''t claim A''s blank label (it looks unknown)');
select throws_ok(format($$select rpc_tag_detach(%L, '00000000-0000-0000-0000-00000000a731')$$,
  pg_temp.code('00000000-0000-0000-0000-0000000f73aa', 0)), '23503', null, 'B can''t detach A''s label');
select throws_ok(format($$select rpc_tag_retire(%L)$$, pg_temp.code('00000000-0000-0000-0000-0000000f73aa', 2)), '23503', null,
  'B can''t retire A''s label');
select throws_ok($$select rpc_label_printed((select id from t_c, jsonb_to_recordset(t_c.v) as s(id uuid) where t_c.k = 'a'))$$,
  '23503', null, 'B can''t touch A''s sheet');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a731', null)$$,
  '23503', null, 'B can''t move A''s thing');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', '00000000-0000-0000-0000-00000000a741', '00000000-0000-0000-0000-00000000c731')$$,
  '23503', null, 'B can''t put B''s thing into A''s box');
select throws_ok($$select rpc_move(gen_random_uuid(), 'location', '00000000-0000-0000-0000-00000000c731', '00000000-0000-0000-0000-00000000c741')$$,
  '23503', null, 'B can''t move A''s box');
select is((rpc_move('00000000-0000-0000-0000-0000000003a1', 'asset', '00000000-0000-0000-0000-00000000a741',
  '00000000-0000-0000-0000-00000000c741') ->> 'replayed'), null, 'A''s op id replays nothing for B (op ids are per household)');

-- ── Viewer A: reads, doesn't write ────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7303","role":"authenticated"}';
select is((select asset_id from label_tag where slot = 0), '00000000-0000-0000-0000-00000000a731'::uuid, 'A''s label is untouched by B');
select is((select array[unused, used, retired] from v_label_sheet), '{5,1,0}'::int[], 'the viewer sees the counts');
select is((select location_id from asset where id = '00000000-0000-0000-0000-00000000a731'), '00000000-0000-0000-0000-00000000c731'::uuid,
  'A''s thing is still in Box A');
select throws_ok($$select rpc_label_sheets('00000000-0000-0000-0000-0000000f73aa', 'a4', 1, 54)$$, '42501', null, 'a viewer can''t make sheets');
select throws_ok($$select rpc_tag_assign((select code from label_tag where slot = 1), 'asset', '00000000-0000-0000-0000-00000000a731')$$,
  '42501', null, 'a viewer can''t assign labels');
select throws_ok($$select rpc_move(gen_random_uuid(), 'location', '00000000-0000-0000-0000-00000000c731', '00000000-0000-0000-0000-00000000c732')$$,
  '42501', null, 'a viewer can''t move');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from label_tag$$, '42501', null, 'anon can''t read labels');
select throws_ok($$select rpc_tag_assign('HL:TAG:000000', 'asset', gen_random_uuid())$$, '42501', null, 'anon can''t assign');
select throws_ok($$select rpc_move(gen_random_uuid(), 'asset', gen_random_uuid(), null)$$, '42501', null, 'anon can''t move');

select * from finish();
rollback;
