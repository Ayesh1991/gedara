-- Phase 7e: Things carry retail barcodes (copies may share one); rpc_product_to_thing moves a
-- product (a book entered in Pantry) into Things with its barcodes, extra QR labels and photo, drops
-- an empty accidental stock history, and refuses stock left, bill-bought stock and variants.
-- Another household can't move my product, read or add my asset barcodes; a viewer can't move.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f8a01', 'p7e-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8a03', 'p7e-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8b01', 'p7e-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f8aaa', 'Books A'),
  ('00000000-0000-0000-0000-0000000f8bbb', 'Books B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-0000000f8a01', 'owner'),
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-0000000f8a03', 'viewer'),
  ('00000000-0000-0000-0000-0000000f8bbb', '00000000-0000-0000-0000-0000000f8b01', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c8a1', '00000000-0000-0000-0000-0000000f8aaa', 'Rack 1');
insert into product (id, household_id, name, stock_unit_id, due_type, notes, default_location_id) values
  ('00000000-0000-0000-0000-00000000d8a1', '00000000-0000-0000-0000-0000000f8aaa', 'Rosemaryta babek Book 0060',
   (select id from unit where household_id is null and code = 'pcs'), 'none', 'Sinhala novel', '00000000-0000-0000-0000-00000000c8a1'),
  ('00000000-0000-0000-0000-00000000d8a2', '00000000-0000-0000-0000-0000000f8aaa', 'Sooriya Kusuma Book 0059',
   (select id from unit where household_id is null and code = 'pcs'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d8a3', '00000000-0000-0000-0000-0000000f8aaa', 'Rice',
   (select id from unit where household_id is null and code = 'g'), 'none', null, null);
insert into product_barcode (household_id, product_id, barcode) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000d8a1', '9789556778052'),
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000d8a2', '9789556778069');
insert into category (id, household_id, name, kind, default_destiny) values
  ('00000000-0000-0000-0000-00000000b8a1', '00000000-0000-0000-0000-0000000f8aaa', 'Non-consumables', 'expense', 'asset'),
  ('00000000-0000-0000-0000-00000000b8a2', '00000000-0000-0000-0000-0000000f8aaa', 'Food', 'expense', 'stock');
insert into attachment (id, household_id, entity_type, entity_id, kind, storage_path, mime, is_primary) values
  ('00000000-0000-0000-0000-00000000f8a1', '00000000-0000-0000-0000-0000000f8aaa', 'product', '00000000-0000-0000-0000-00000000d8a1',
   'photo', '00000000-0000-0000-0000-0000000f8aaa/product/x/a.webp', 'image/webp', true);

create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a01","role":"authenticated"}';
insert into t_c values ('sheet', rpc_label_sheets('00000000-0000-0000-0000-0000000f8aaa', 'sq10', 1, 2));
insert into t_c values ('tag', to_jsonb(rpc_tag_assign((select code from label_tag where slot = 0), 'product', '00000000-0000-0000-0000-00000000d8a1')));
-- Book 0059: an accidental add + use (nothing left, no bill).
insert into t_c values ('buy', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f8aaa',
  'product_id', '00000000-0000-0000-0000-00000000d8a2', 'qty', 1)));
insert into t_c values ('use', rpc_consume(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f8aaa',
  'product_id', '00000000-0000-0000-0000-00000000d8a2', 'qty', 1)));
insert into t_c values ('rice', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f8aaa',
  'product_id', '00000000-0000-0000-0000-00000000d8a3', 'qty', 500)));

-- ── Moving a book ─────────────────────────────────────────────────────────────
insert into t_c values ('book', to_jsonb(rpc_product_to_thing('00000000-0000-0000-0000-00000000d8a1')));
select is((select name from asset where id = (select (v #>> '{}')::uuid from t_c where k = 'book')), 'Rosemaryta babek Book 0060',
  'the book is a Thing now');
select is((select array[description, location_id::text] from asset where id = (select (v #>> '{}')::uuid from t_c where k = 'book')),
  array['Sinhala novel', '00000000-0000-0000-0000-00000000c8a1'], 'notes and usual place come along');
select ok((select code ~ '^HL:AST:' and asset_no > 0 from asset where id = (select (v #>> '{}')::uuid from t_c where k = 'book')),
  'it has its own HL:AST code and A-number');
select is((select barcode from asset_barcode where asset_id = (select (v #>> '{}')::uuid from t_c where k = 'book')), '9789556778052',
  'its ISBN barcode now finds the Thing');
select is((select asset_id from label_tag where slot = 0), (select (v #>> '{}')::uuid from t_c where k = 'book'),
  'its QR label opens the Thing');
select is((select array[entity_type, entity_id::text] from attachment where id = '00000000-0000-0000-0000-00000000f8a1'),
  array['asset', (select v #>> '{}' from t_c where k = 'book')], 'its photo is the Thing''s photo');
select is((select count(*)::int from product where id = '00000000-0000-0000-0000-00000000d8a1'), 0, 'the product is gone');
select is((select count(*)::int from product_barcode where barcode = '9789556778052'), 0, 'and its Pantry barcode');

-- ── An empty accidental history goes with it; stock, bills and variants stay ─
select lives_ok($$select rpc_product_to_thing('00000000-0000-0000-0000-00000000d8a2')$$,
  'a book with an add + use and nothing left moves too');
select is((select count(*)::int from stock_movement where product_id = '00000000-0000-0000-0000-00000000d8a2'), 0,
  '… its empty stock history is gone');
select throws_ok($$select rpc_product_to_thing('00000000-0000-0000-0000-00000000d8a3')$$, 'GDSTK', null,
  'a product with stock left stays in Pantry');

-- ── Copies share an ISBN ──────────────────────────────────────────────────────
insert into asset (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000a8a2', '00000000-0000-0000-0000-0000000f8aaa', 'Rosemaryta babek Book 0060 (2nd copy)');
select lives_ok($$insert into asset_barcode (household_id, asset_id, barcode) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000a8a2', '9789556778052')$$,
  'a second copy can carry the same ISBN');
select is((select count(*)::int from asset_barcode where barcode = '9789556778052'), 2, 'the ISBN finds both copies');
select throws_ok($$insert into asset_barcode (household_id, asset_id, barcode) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000a8a2', '9789556778052')$$,
  '23505', null, 'but not twice on the same copy');

-- ── A sub-category added in the app takes its main category's destiny ─────────
insert into category (household_id, parent_id, name, kind) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000b8a1', 'Books', 'expense'),
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000b8a2', 'Snacks', 'expense');
select is((select default_destiny from category where parent_id = '00000000-0000-0000-0000-00000000b8a1' and name = 'Books'), 'asset',
  'a new sub-category under Non-consumables is Things');
select is((select default_destiny from category where parent_id = '00000000-0000-0000-0000-00000000b8a2' and name = 'Snacks'), 'stock',
  'and one under Food is pantry stock');

-- ── Other household / viewer / anon ───────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8b01","role":"authenticated"}';
select is((select count(*)::int from asset_barcode), 0, 'B sees none of A''s thing barcodes');
select throws_ok($$select rpc_product_to_thing('00000000-0000-0000-0000-00000000d8a3')$$, '23503', null, 'B can''t move A''s product');
select throws_ok($$insert into asset_barcode (household_id, asset_id, barcode) values
  ('00000000-0000-0000-0000-0000000f8aaa', '00000000-0000-0000-0000-00000000a8a2', '1111111111')$$,
  '42501', null, 'B can''t add a barcode to A''s thing');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8a03","role":"authenticated"}';
select is((select count(*)::int from asset_barcode), 3, 'the viewer sees A''s thing barcodes (both books and the copy)');
select throws_ok($$select rpc_product_to_thing('00000000-0000-0000-0000-00000000d8a3')$$, '42501', null, 'a viewer can''t move products');

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from asset_barcode$$, '42501', null, 'anon can''t read thing barcodes');

select * from finish();
rollback;
