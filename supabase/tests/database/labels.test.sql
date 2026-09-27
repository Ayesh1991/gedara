-- Phase 7b behaviour: blank label sheets (numbering, fresh unique codes, never reused), assigning a
-- blank label (place / thing / product, extra labels next to the item's own code), Undo / detach,
-- retire (final), deleting the item returns the label to blank, the permanence guard, reprint count.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(38);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7101', 'p7b-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7201', 'p7b-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f71aa', 'Labels A'),
  ('00000000-0000-0000-0000-0000000f72bb', 'Labels B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f71aa', '00000000-0000-0000-0000-0000000f7101', 'owner'),
  ('00000000-0000-0000-0000-0000000f72bb', '00000000-0000-0000-0000-0000000f7201', 'owner');
insert into location (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-0000000f71aa', 'Store room', 'room'),
  ('00000000-0000-0000-0000-00000000c7b1', '00000000-0000-0000-0000-0000000f72bb', 'Room B', 'room');
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000a701', '00000000-0000-0000-0000-0000000f71aa', 'Drill'),
  ('00000000-0000-0000-0000-00000000a702', '00000000-0000-0000-0000-0000000f71aa', 'Ladder');
insert into product (id, household_id, name, stock_unit_id, due_type) values
  ('00000000-0000-0000-0000-00000000d701', '00000000-0000-0000-0000-0000000f71aa', 'Rice',
   (select id from unit where household_id is null and code = 'g'), 'none');

create function pg_temp.tag(p_sheet integer, p_slot integer) returns text language sql stable as
  $$ select t.code from public.label_tag t join public.label_sheet s on s.id = t.sheet_id
      where s.household_id = '00000000-0000-0000-0000-0000000f71aa' and s.sheet_no = p_sheet and t.slot = p_slot $$;
create function pg_temp.target(p_code text) returns uuid language sql stable as
  $$ select coalesce(location_id, asset_id, product_id) from public.label_tag where code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7101","role":"authenticated"}';

-- ── Sheets ────────────────────────────────────────────────────────────────────
insert into t_c values ('a4', rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'a4', 2, 54));
select is(jsonb_array_length((select v from t_c where k = 'a4')), 2, 'two sheets made at once');
select is((select array_agg(sheet_no order by sheet_no) from label_sheet), '{1,2}'::int[], 'numbered 1 and 2');
select is((select count(*)::int from label_tag), 108, '54 labels per sheet');
select is((select count(distinct code)::int from label_tag), 108, 'every code is different');
select is((select count(*)::int from label_tag where code !~ '^HL:TAG:[0-9A-HJKMNP-TV-Z]{6}$'), 0, 'HL:TAG codes, Crockford upper case');
select is((select count(distinct slot)::int from label_tag t join label_sheet s on s.id = t.sheet_id where s.sheet_no = 2), 54,
  'slots 0..53 on each sheet');
select is((select array_agg(unused order by sheet_no) from v_label_sheet), '{54,54}'::int[], 'all unused at first');
insert into t_c values ('sq20', rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'sq20', 1, 20));
select is((select sheet_no from label_sheet where format = 'sq20'), 3, 'the next batch is sheet 3, whatever its format');
select throws_ok($$select rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'poster', 1, 10)$$, '23514', null, 'unknown format refused');
select throws_ok($$select rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'a4', 11, 54)$$, '23514', null, 'at most 10 sheets at a time');
select throws_ok($$select rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'a4', 1, 301)$$, '23514', null, 'at most 300 labels a sheet');

-- ── Assign ────────────────────────────────────────────────────────────────────
select lives_ok(format($$select rpc_tag_assign(%L, 'location', '00000000-0000-0000-0000-00000000c701')$$, pg_temp.tag(1, 0)),
  'a blank label becomes a place');
select is(pg_temp.target(pg_temp.tag(1, 0)), '00000000-0000-0000-0000-00000000c701'::uuid, '… and means that place');
select throws_ok(format($$select rpc_tag_assign(%L, 'asset', '00000000-0000-0000-0000-00000000a701')$$, pg_temp.tag(1, 0)),
  'GDTAG', null, 'a label that already means something can''t be assigned again');
select lives_ok(format($$select rpc_tag_assign(%L, 'location', '00000000-0000-0000-0000-00000000c701')$$, pg_temp.tag(1, 1)),
  'a second label on the same place');
select is((select count(*)::int from label_tag where location_id = '00000000-0000-0000-0000-00000000c701'), 2,
  'both labels open the place (next to its own HL:LOC code)');
select lives_ok(format($$select rpc_tag_assign(%L, 'product', '00000000-0000-0000-0000-00000000d701')$$, lower(' ' || pg_temp.tag(1, 2) || ' ')),
  'codes are matched case- and space-insensitively');
select throws_ok(format($$select rpc_tag_assign(%L, 'box', '00000000-0000-0000-0000-00000000c701')$$, pg_temp.tag(1, 3)),
  '23514', null, 'unknown kind refused');
select throws_ok(format($$select rpc_tag_assign(%L, 'location', '00000000-0000-0000-0000-00000000c7b1')$$, pg_temp.tag(1, 3)),
  '23503', null, 'a label can''t point at another household''s place');
select throws_ok($$select rpc_tag_assign('HL:TAG:ZZZZZZ', 'location', '00000000-0000-0000-0000-00000000c701')$$,
  '23503', null, 'an unknown code is refused');

-- ── Undo / detach ─────────────────────────────────────────────────────────────
select throws_ok(format($$select rpc_tag_detach(%L, '00000000-0000-0000-0000-00000000a701')$$, pg_temp.tag(1, 1)),
  'GDTAG', null, 'detach refuses when the label means something else now');
select lives_ok(format($$select rpc_tag_detach(%L, '00000000-0000-0000-0000-00000000c701')$$, pg_temp.tag(1, 1)),
  'detach (Undo) the second label');
select is((select num_nonnulls(location_id, asset_id, product_id, assigned_at)::int from label_tag where code = pg_temp.tag(1, 1)), 0,
  'the sticker is blank again');
select lives_ok(format($$select rpc_tag_assign(%L, 'asset', '00000000-0000-0000-0000-00000000a701')$$, pg_temp.tag(1, 1)),
  '… and can be assigned to something else');

-- ── Retire ────────────────────────────────────────────────────────────────────
select lives_ok(format($$select rpc_tag_retire(%L)$$, pg_temp.tag(1, 3)), 'a blank label is retired');
select throws_ok(format($$select rpc_tag_assign(%L, 'asset', '00000000-0000-0000-0000-00000000a702')$$, pg_temp.tag(1, 3)),
  'GDTAG', null, 'a retired label can never be assigned');
select lives_ok(format($$select rpc_tag_retire(%L)$$, pg_temp.tag(1, 3)), 'retiring twice is harmless');
select lives_ok(format($$select rpc_tag_retire(%L)$$, pg_temp.tag(1, 2)), 'an assigned label can be retired too');
select is(pg_temp.target(pg_temp.tag(1, 2)), null::uuid, '… and no longer opens the product');
select is((select array[unused, used, retired] from v_label_sheet where sheet_no = 1), '{50,2,2}'::int[],
  'sheet 1: 50 unused, 2 used, 2 retired');

-- ── Deleting the item makes its label blank ───────────────────────────────────
delete from asset where id = '00000000-0000-0000-0000-00000000a701';
select is(pg_temp.target(pg_temp.tag(1, 1)), null::uuid, 'the drill''s label is blank again');
select is((select retired_at from label_tag where code = pg_temp.tag(1, 1)), null::timestamptz, '… not retired');

-- ── Reprint count ─────────────────────────────────────────────────────────────
select lives_ok($$select rpc_label_printed((select id from label_sheet where sheet_no = 1))$$, 'a reprint is counted');
select is((select print_count from label_sheet where sheet_no = 1), 1, 'print count 1');

-- ── Permanence guard (whoever writes) ─────────────────────────────────────────
insert into t_c values ('code', to_jsonb(pg_temp.tag(1, 0)));
insert into t_c values ('retired', to_jsonb(pg_temp.tag(1, 3)));
reset role;
select throws_ok($$update label_tag set code = 'HL:TAG:000000' where code = (select v #>> '{}' from t_c where k = 'code')$$,
  '23514', null, 'a printed code never changes');
select throws_ok($$update label_tag set retired_at = null where code = (select v #>> '{}' from t_c where k = 'retired')$$,
  'GDTAG', null, 'a retired label stays retired');

-- Codes are never handed out again: even if a sheet disappeared, numbering and codes move on.
delete from label_sheet where household_id = '00000000-0000-0000-0000-0000000f71aa' and sheet_no = 3;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7101","role":"authenticated"}';
insert into t_c values ('again', rpc_label_sheets('00000000-0000-0000-0000-0000000f71aa', 'sq10', 1, 10));
select is((select max(sheet_no) from label_sheet), 4, 'sheet numbers never go back');
select is((select count(*)::int from label_tag t join label_sheet s on s.id = t.sheet_id
            where s.sheet_no = 4 and t.code in (select c.code from label_tag c join label_sheet cs on cs.id = c.sheet_id where cs.sheet_no < 4)),
  0, 'new codes never repeat older ones');

select * from finish();
rollback;
