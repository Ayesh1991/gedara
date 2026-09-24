-- Products, barcodes, unit conversions and household units: household isolation, viewer read-only,
-- immutable HL:PRD codes, same-household references, one product per barcode, one-level parents.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(34);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f4101', 'prd-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f4103', 'prd-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f4201', 'prd-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f41aa', 'Prd A'),
  ('00000000-0000-0000-0000-0000000f42bb', 'Prd B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-0000000f4101', 'owner'),
  ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-0000000f4103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f42bb', '00000000-0000-0000-0000-0000000f4201', 'owner');
insert into category (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-0000000f41aa', 'Grocery A'),
  ('00000000-0000-0000-0000-00000000e4b1', '00000000-0000-0000-0000-0000000f42bb', 'Grocery B');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-0000000f41aa', 'Kitchen A'),
  ('00000000-0000-0000-0000-00000000c4b1', '00000000-0000-0000-0000-0000000f42bb', 'Kitchen B');
insert into unit (id, household_id, code, name, dimension, to_base) values
  ('00000000-0000-0000-0000-00000000a4b1', '00000000-0000-0000-0000-0000000f42bb', 'tin', 'tin', 'other', 1);
insert into product (id, household_id, name, stock_unit_id) values
  ('00000000-0000-0000-0000-00000000d4b1', '00000000-0000-0000-0000-0000000f42bb', 'Rice B', pg_temp.u('g'));

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f4101","role":"authenticated"}';

select lives_ok($$insert into product (id, household_id, name, name_si, category_id, stock_unit_id, purchase_unit_id,
                                        default_location_id, due_type, default_due_days)
  values ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f41aa', '  Sugar ', ' සීනි ',
          '00000000-0000-0000-0000-00000000e401', pg_temp.u('g'), pg_temp.u('pack'),
          '00000000-0000-0000-0000-00000000c401', 'best_before', 180)$$, 'owner adds a product');
select is((select name || '|' || name_si from product where id = '00000000-0000-0000-0000-00000000d401'),
  'Sugar|සීනි', 'names are trimmed');
select ok((select code ~ '^HL:PRD:[0-9A-HJKMNP-TV-Z]{6}$' from product where id = '00000000-0000-0000-0000-00000000d401'),
  'the product gets an HL:PRD code');
select throws_ok($$insert into product (household_id, name, stock_unit_id, code)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Salt', pg_temp.u('g'), 'HL:PRD:AAAAAA')$$,
  '42501', null, 'the client can''t choose a code');
select throws_ok($$update product set code = 'HL:PRD:AAAAAA' where id = '00000000-0000-0000-0000-00000000d401'$$,
  '42501', null, 'the client can''t change a code');
select throws_ok($$insert into product (household_id, name, stock_unit_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'SUGAR', pg_temp.u('g'))$$,
  '23505', null, 'product names are unique per household, ignoring case');
select throws_ok($$insert into product (household_id, name, stock_unit_id, category_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Salt', pg_temp.u('g'), '00000000-0000-0000-0000-00000000e4b1')$$,
  '23503', null, 'another household''s category is rejected');
select throws_ok($$insert into product (household_id, name, stock_unit_id, default_location_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Salt', pg_temp.u('g'), '00000000-0000-0000-0000-00000000c4b1')$$,
  '23503', null, 'another household''s place is rejected');
select throws_ok($$insert into product (household_id, name, stock_unit_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Salt', '00000000-0000-0000-0000-00000000a4b1')$$,
  '23503', null, 'another household''s unit is rejected');

-- Parents: one level.
select lives_ok($$insert into product (id, household_id, name, stock_unit_id, parent_id)
  values ('00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f41aa', 'Brown sugar', pg_temp.u('g'),
          '00000000-0000-0000-0000-00000000d401')$$, 'a sub-product');
select throws_ok($$insert into product (household_id, name, stock_unit_id, parent_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Kithul jaggery', pg_temp.u('g'), '00000000-0000-0000-0000-00000000d402')$$,
  '23514', null, 'sub-products can''t have sub-products');
select throws_ok($$update product set parent_id = '00000000-0000-0000-0000-00000000d402' where id = '00000000-0000-0000-0000-00000000d401'$$,
  '23514', null, 'a product with sub-products stays top-level');
select throws_ok($$insert into product (household_id, name, stock_unit_id, parent_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Basmati', pg_temp.u('g'), '00000000-0000-0000-0000-00000000d4b1')$$,
  '23503', null, 'a parent in another household is rejected');

-- Household units.
select lives_ok($$insert into unit (household_id, code, name, dimension, to_base, aliases)
  values ('00000000-0000-0000-0000-0000000f41aa', ' sachet ', 'sachet', 'other', 1,
          '{" Sachets ","", "SACHET"}')$$, 'owner adds a household unit');
select is((select code || ' ' || array_to_string(aliases, ',') from unit where household_id = '00000000-0000-0000-0000-0000000f41aa'),
  'sachet sachet,sachets', 'unit code trimmed, aliases lower-cased, de-duplicated, blanks dropped');
select throws_ok($$update unit set to_base = 2 where household_id = '00000000-0000-0000-0000-0000000f41aa'$$,
  '42501', null, 'a unit''s size never changes');
select throws_ok($$insert into unit (household_id, code, name, dimension, to_base) values (null, 'zz', 'zz', 'other', 1)$$,
  '42501', null, 'clients can''t add system units');
update unit set name = 'hacked' where id = pg_temp.u('g');
select is((select name from unit where id = pg_temp.u('g')), 'gram', 'system units are read-only');

-- Barcodes and conversions.
select lives_ok($$insert into product_barcode (household_id, product_id, barcode, unit_id, qty)
  values ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-00000000d401', ' 4792024000222 ', pg_temp.u('pack'), 1)$$,
  'owner adds a barcode');
select throws_ok($$insert into product_barcode (household_id, product_id, barcode)
  values ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-00000000d402', '4792024000222')$$,
  '23505', null, 'a barcode belongs to one product per household');
select lives_ok($$insert into product_unit_conversion (household_id, product_id, from_unit_id, to_unit_id, factor)
  values ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-00000000d401', pg_temp.u('pack'), pg_temp.u('g'), 400)$$,
  'owner adds "1 pack = 400 g"');
select throws_ok($$insert into product_barcode (household_id, product_id, barcode)
  values ('00000000-0000-0000-0000-0000000f41aa', '00000000-0000-0000-0000-00000000d4b1', '1234567890128')$$,
  '23503', null, 'a barcode can''t point at another household''s product');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f4103","role":"authenticated"}';

select is((select count(*)::int from product where household_id = '00000000-0000-0000-0000-0000000f41aa'), 2,
  'viewer sees A''s products');
select throws_ok($$insert into product (household_id, name, stock_unit_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Viewer salt', pg_temp.u('g'))$$, '42501', null, 'viewer can''t add products');
update product set name = 'viewer edit' where id = '00000000-0000-0000-0000-00000000d401';
delete from product_barcode where barcode = '4792024000222';

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f4201","role":"authenticated"}';

select is((select count(*)::int from product where household_id = '00000000-0000-0000-0000-0000000f41aa'), 0,
  'B can''t see A''s products');
select is((select count(*)::int from product_barcode where household_id = '00000000-0000-0000-0000-0000000f41aa'), 0,
  'B can''t see A''s barcodes');
select is((select count(*)::int from product_unit_conversion where household_id = '00000000-0000-0000-0000-0000000f41aa'), 0,
  'B can''t see A''s conversions');
select is((select count(*)::int from unit where household_id = '00000000-0000-0000-0000-0000000f41aa'), 0,
  'B can''t see A''s units');
select throws_ok($$insert into product (household_id, name, stock_unit_id)
  values ('00000000-0000-0000-0000-0000000f41aa', 'Rogue', pg_temp.u('g'))$$, '42501', null, 'B can''t add products to A');
select throws_ok($$insert into unit (household_id, code, name, dimension, to_base)
  values ('00000000-0000-0000-0000-0000000f41aa', 'rogue', 'rogue', 'other', 1)$$, '42501', null, 'B can''t add units to A');
select lives_ok($$insert into product_barcode (household_id, product_id, barcode)
  values ('00000000-0000-0000-0000-0000000f42bb', '00000000-0000-0000-0000-00000000d4b1', '4792024000222')$$,
  'the same barcode can exist in another household');
update product set name = 'hacked' where id = '00000000-0000-0000-0000-00000000d401';
delete from product where id = '00000000-0000-0000-0000-00000000d402';
delete from unit where household_id = '00000000-0000-0000-0000-0000000f41aa';

-- ── Owner of A again ──────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f4101","role":"authenticated"}';

select is((select name from product where id = '00000000-0000-0000-0000-00000000d401'), 'Sugar',
  'neither the viewer''s nor B''s update did anything');
select is((select count(*)::int from product_barcode where household_id = '00000000-0000-0000-0000-0000000f41aa')
          + (select count(*)::int from product where household_id = '00000000-0000-0000-0000-0000000f41aa')
          + (select count(*)::int from unit where household_id = '00000000-0000-0000-0000-0000000f41aa'), 4,
  'neither the viewer''s nor B''s deletes did anything');
select lives_ok($$delete from product where id = '00000000-0000-0000-0000-00000000d402'$$,
  'owner deletes a product without stock');

select * from finish();
rollback;
