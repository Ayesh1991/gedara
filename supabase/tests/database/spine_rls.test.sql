-- Learned bill names + shopping list: household isolation, viewer read-only, aliases are written
-- only by the routing RPCs, list stamps / source / bill link are never client-written, one open
-- item per product, the below-minimum sync.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(36);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fa101', 'spine-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa103', 'spine-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fa201', 'spine-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fa1aa', 'Spine A'),
  ('00000000-0000-0000-0000-0000000fa2bb', 'Spine B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa101', 'owner'),
  ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-0000000fa103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fa2bb', '00000000-0000-0000-0000-0000000fa201', 'owner');
insert into product (id, household_id, name, stock_unit_id, min_qty, reorder_qty) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-0000000fa1aa', 'Sugar', pg_temp.u('g'), 500, 1000),
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-0000000fa1aa', 'Tea', pg_temp.u('g'), 100, null),
  ('00000000-0000-0000-0000-00000000da03', '00000000-0000-0000-0000-0000000fa1aa', 'Salt', pg_temp.u('g'), null, null),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-0000000fa2bb', 'Rice B', pg_temp.u('g'), null, null);
insert into unit (id, household_id, code, name, dimension, to_base) values
  ('00000000-0000-0000-0000-00000000aab1', '00000000-0000-0000-0000-0000000fa2bb', 'tinb', 'tin', 'other', 1);
-- Learned names can only come from the RPCs; these are fixtures.
insert into product_alias (id, household_id, alias_norm, destiny, product_id) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000fa1aa', 'white sugar 1kg', 'stock', '00000000-0000-0000-0000-00000000da01'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000fa1aa', 'aquafina water', 'expense', null),
  ('00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-0000000fa2bb', 'rice', 'stock', '00000000-0000-0000-0000-00000000db01');

select is(private.bill_name_norm('  ANCHOR Hot-Choc. 400g  (Pouch) '), 'anchor hot choc 400g pouch',
  'bill names: lower-case, punctuation to spaces, single spaces');
select is(private.bill_name_norm('Kist [Mayo] {x}~_ සීනි'), 'kist mayo x සීනි', 'brackets and symbols go; Sinhala stays');
select throws_ok($$insert into product_alias (household_id, alias_norm, destiny, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'Not Normal', 'expense', null)$$,
  '23514', null, 'an alias must already be normalised');
select throws_ok($$insert into product_alias (household_id, alias_norm, destiny, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'tea', 'expense', '00000000-0000-0000-0000-00000000da02')$$,
  '23514', null, 'only stock aliases point at a product');
select throws_ok($$insert into product_alias (household_id, alias_norm, destiny, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'rice b', 'stock', '00000000-0000-0000-0000-00000000db01')$$,
  '23503', null, 'an alias can''t point at another household''s product');

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa101","role":"authenticated"}';

select is((select count(*)::int from product_alias), 2, 'owner sees A''s learned names only');
select throws_ok($$insert into product_alias (household_id, alias_norm, destiny, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'tea leaves', 'stock', '00000000-0000-0000-0000-00000000da02')$$,
  '42501', null, 'learned names are only written by the routing RPCs');
select throws_ok($$update product_alias set product_id = '00000000-0000-0000-0000-00000000da02'
  where id = '00000000-0000-0000-0000-00000000aa01'$$, '42501', null, 'learned names can''t be edited');
select lives_ok($$delete from product_alias where id = '00000000-0000-0000-0000-00000000aa02'$$, 'owner forgets a learned name');

select lives_ok($$insert into shopping_list_item (id, household_id, product_id, qty, unit_id)
  values ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-0000000fa1aa',
          '00000000-0000-0000-0000-00000000da02', 250, pg_temp.u('g'))$$, 'owner adds a product to the list');
select lives_ok($$insert into shopping_list_item (id, household_id, free_text)
  values ('00000000-0000-0000-0000-00000000ac02', '00000000-0000-0000-0000-0000000fa1aa', '  Birthday candles ')$$,
  'owner adds free text');
select is((select free_text || '|' || source || '|' || list from shopping_list_item where id = '00000000-0000-0000-0000-00000000ac02'),
  'Birthday candles|manual|Main', 'text trimmed, manual, on the Main list');
select throws_ok($$insert into shopping_list_item (household_id, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-00000000da02')$$,
  '23505', null, 'one open item per product per list');
select throws_ok($$insert into shopping_list_item (household_id, product_id, free_text)
  values ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-00000000da03', 'salt')$$,
  '23514', null, 'an item is a product or free text, not both');
select throws_ok($$insert into shopping_list_item (household_id, free_text, source)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'x', 'below_min')$$,
  '42501', null, 'the client can''t set the source');
select throws_ok($$insert into shopping_list_item (household_id, product_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', '00000000-0000-0000-0000-00000000db01')$$,
  '23503', null, 'another household''s product is rejected');
select throws_ok($$insert into shopping_list_item (household_id, free_text, unit_id)
  values ('00000000-0000-0000-0000-0000000fa1aa', 'tins', '00000000-0000-0000-0000-00000000aab1')$$,
  '23503', null, 'another household''s unit is rejected');
select throws_ok($$update shopping_list_item set done_by_line = gen_random_uuid() where id = '00000000-0000-0000-0000-00000000ac02'$$,
  '42501', null, 'the client can''t link an item to a bill line');

update shopping_list_item set done = true where id = '00000000-0000-0000-0000-00000000ac02';
select is((select (done_at is not null) || ' ' || done_by from shopping_list_item where id = '00000000-0000-0000-0000-00000000ac02'),
  'true 00000000-0000-0000-0000-0000000fa101', 'ticking stamps who and when');
update shopping_list_item set done = false where id = '00000000-0000-0000-0000-00000000ac02';
select is((select coalesce(done_at::text, '-') || ' ' || coalesce(done_by::text, '-') from shopping_list_item
            where id = '00000000-0000-0000-0000-00000000ac02'), '- -', 'unticking clears the stamps');

-- Below-minimum sync: Sugar (0 < 500) and Tea (0 < 100, already on the list) are low; Salt has no minimum.
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 1, "removed": 0}'::jsonb,
  'sync adds the low product that isn''t on the list yet');
select is((select qty || ' ' || source from shopping_list_item where product_id = '00000000-0000-0000-0000-00000000da01'),
  '1000.0000 below_min', 'with the reorder quantity');
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 0, "removed": 0}'::jsonb,
  'running it again changes nothing');
update shopping_list_item set dismissed = true where product_id = '00000000-0000-0000-0000-00000000da01';
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 0, "removed": 0}'::jsonb,
  '"not now" is not undone by the next sync');
update shopping_list_item set dismissed = false where product_id = '00000000-0000-0000-0000-00000000da01';
update product set min_qty = null where id = '00000000-0000-0000-0000-00000000da01';
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 0, "removed": 1}'::jsonb,
  'an automatic item goes when the product is no longer low');
update product set min_qty = 500 where id = '00000000-0000-0000-0000-00000000da01';
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 1, "removed": 0}'::jsonb,
  '… and comes back when it is');
update shopping_list_item set qty = 2000 where product_id = '00000000-0000-0000-0000-00000000da01';
update product set min_qty = null where id = '00000000-0000-0000-0000-00000000da01';
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa') ->> 'removed', '0',
  'an automatic item the user edited is theirs (not removed)');
select is((select source from shopping_list_item where product_id = '00000000-0000-0000-0000-00000000da01'), 'manual',
  'editing the quantity made it manual');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa103","role":"authenticated"}';

select is((select count(*)::int from shopping_list_item), 3, 'viewer sees A''s list');
select throws_ok($$insert into shopping_list_item (household_id, free_text) values ('00000000-0000-0000-0000-0000000fa1aa', 'viewer')$$,
  '42501', null, 'viewer can''t add to the list');
update shopping_list_item set done = true where id = '00000000-0000-0000-0000-00000000ac01';
delete from product_alias;
select is(rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa'), '{"added": 0, "removed": 0}'::jsonb,
  'viewer''s sync writes nothing');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa201","role":"authenticated"}';

select is((select count(*)::int from shopping_list_item where household_id = '00000000-0000-0000-0000-0000000fa1aa')
          + (select count(*)::int from product_alias where household_id = '00000000-0000-0000-0000-0000000fa1aa'), 0,
  'B can''t see A''s list or learned names');
select throws_ok($$insert into shopping_list_item (household_id, free_text) values ('00000000-0000-0000-0000-0000000fa1aa', 'rogue')$$,
  '42501', null, 'B can''t add to A''s list');
select throws_ok($$select rpc_shopping_sync('00000000-0000-0000-0000-0000000fa1aa')$$, '42501', null, 'B can''t sync A''s list');
update shopping_list_item set done = true where household_id = '00000000-0000-0000-0000-0000000fa1aa';
delete from shopping_list_item where household_id = '00000000-0000-0000-0000-0000000fa1aa';
delete from product_alias where household_id = '00000000-0000-0000-0000-0000000fa1aa';

-- ── Owner of A again ──────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fa101","role":"authenticated"}';

select is((select count(*)::int from shopping_list_item where not done), 3,
  'neither the viewer''s nor B''s updates / deletes did anything to the list');
select is((select count(*)::int from product_alias), 1, 'neither deleted A''s learned names');

select * from finish();
rollback;
