-- Phase 7f: rpc_product_merge moves everything of a duplicate product ("Freelan Mustard Seeds") to
-- the one kept ("Mustard seeds") and archives the duplicate. Same stock unit → lots and journal are
-- re-pointed (no quantity changes); another unit that converts (pack → g) → stock moves by transfer
-- into new lots; no conversion → GDUNT and nothing changes. A merge can't be undone.
-- Another household can't merge (or reach) my products; a viewer can't merge; nobody sets
-- merged_into_id directly.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(41);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f9a01', 'p7f-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9a03', 'p7f-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f9b01', 'p7f-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f9aaa', 'Merge A'),
  ('00000000-0000-0000-0000-0000000f9bbb', 'Merge B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-0000000f9a01', 'owner'),
  ('00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-0000000f9a03', 'viewer'),
  ('00000000-0000-0000-0000-0000000f9bbb', '00000000-0000-0000-0000-0000000f9b01', 'owner');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-00000000c9a0', '00000000-0000-0000-0000-0000000f9aaa', 'Spice rack');
insert into product (id, household_id, name, stock_unit_id, due_type, default_location_id, parent_id) values
  ('00000000-0000-0000-0000-00000000d9a1', '00000000-0000-0000-0000-0000000f9aaa', 'Mustard seeds', pg_temp.u('g'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-0000000f9aaa', 'Freelan Mustard Seeds', pg_temp.u('g'), 'none',
   '00000000-0000-0000-0000-00000000c9a0', null),
  ('00000000-0000-0000-0000-00000000d9a3', '00000000-0000-0000-0000-0000000f9aaa', 'Brown sugar', pg_temp.u('g'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d9a4', '00000000-0000-0000-0000-0000000f9aaa', 'Brown sugar 1kg pack', pg_temp.u('pack'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d9a5', '00000000-0000-0000-0000-0000000f9aaa', 'Eggs', pg_temp.u('pcs'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d9a6', '00000000-0000-0000-0000-0000000f9aaa', 'Curry powder', pg_temp.u('g'), 'none', null, null),
  ('00000000-0000-0000-0000-00000000d9b1', '00000000-0000-0000-0000-0000000f9bbb', 'Mustard', pg_temp.u('g'), 'none', null, null);
insert into product (id, household_id, name, stock_unit_id, due_type, parent_id) values
  ('00000000-0000-0000-0000-00000000d9a7', '00000000-0000-0000-0000-0000000f9aaa', 'Curry powder roasted', pg_temp.u('g'), 'none',
   '00000000-0000-0000-0000-00000000d9a6');
insert into product (id, household_id, name, stock_unit_id, due_type, archived) values
  ('00000000-0000-0000-0000-00000000d9a8', '00000000-0000-0000-0000-0000000f9aaa', 'Old pepper', pg_temp.u('g'), 'none', true);
insert into product_unit_conversion (household_id, product_id, from_unit_id, to_unit_id, factor) values
  ('00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a4', pg_temp.u('pack'), pg_temp.u('g'), 1000);
insert into location (id, household_id, name, kind, holds_product_id, tare_g) values
  ('00000000-0000-0000-0000-00000000c9a1', '00000000-0000-0000-0000-0000000f9aaa', 'Mustard jar', 'container',
   '00000000-0000-0000-0000-00000000d9a2', 300);
insert into product_alias (household_id, alias_norm, destiny, product_id) values
  ('00000000-0000-0000-0000-0000000f9aaa', 'freelan mustard seeds 100g', 'stock', '00000000-0000-0000-0000-00000000d9a2');
insert into product_barcode (household_id, product_id, barcode) values
  ('00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a2', '4790000000101'),
  ('00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a4', '4790000000202');
insert into shopping_list_item (id, household_id, product_id, done) values
  ('00000000-0000-0000-0000-00000000e9a1', '00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a2', false),
  ('00000000-0000-0000-0000-00000000e9a2', '00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a1', false),
  ('00000000-0000-0000-0000-00000000e9a3', '00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000d9a2', true);
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000a9a1', '00000000-0000-0000-0000-0000000f9aaa', 'Cash', 'cash');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-00000000b9a1', '00000000-0000-0000-0000-0000000f9aaa', 'expense',
   '00000000-0000-0000-0000-00000000a9a1', 'Keells', current_date, 150, 'p7fmerge1');
insert into transaction_line (id, household_id, transaction_id, line_no, raw_name, amount, fingerprint, product_id) values
  ('00000000-0000-0000-0000-00000000b9b1', '00000000-0000-0000-0000-0000000f9aaa', '00000000-0000-0000-0000-00000000b9a1', 0,
   'FREELAN MUSTARD SEEDS 100G', 150, 'p7fmerge1-0-a', '00000000-0000-0000-0000-00000000d9a2');
insert into scale_reading (household_id, op_id, at, status, result, location_id, product_id) values
  ('00000000-0000-0000-0000-0000000f9aaa', gen_random_uuid(), now(), 'no_change', '{}',
   '00000000-0000-0000-0000-00000000c9a1', '00000000-0000-0000-0000-00000000d9a2');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9a01","role":"authenticated"}';
insert into t_c values ('sheet', rpc_label_sheets('00000000-0000-0000-0000-0000000f9aaa', 'sq10', 1, 1));
insert into t_c values ('tag', to_jsonb(rpc_tag_assign((select code from label_tag where household_id = '00000000-0000-0000-0000-0000000f9aaa' and slot = 0),
  'product', '00000000-0000-0000-0000-00000000d9a2')));
-- Freelan: 300 g in the jar for Rs 150 (Rs 0.50 / g), 50 g used. Mustard seeds: 200 g.
insert into t_c values ('buy1', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a2', 'qty', 300, 'total_cost', 150,
  'location_id', '00000000-0000-0000-0000-00000000c9a1', 'transaction_line_id', '00000000-0000-0000-0000-00000000b9b1')));
insert into t_c values ('use1', rpc_consume(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a2', 'qty', 50)));
insert into t_c values ('buy2', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a1', 'qty', 200, 'total_cost', 120)));
-- Brown sugar 1kg pack: 2 packs for Rs 900.
insert into t_c values ('buy3', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a4', 'qty', 2, 'total_cost', 900)));
insert into t_c values ('buy4', rpc_purchase(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a5', 'qty', 10)));

-- ── Other household / viewer first (nothing may change) ───────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9b01","role":"authenticated"}';
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9a1')$$,
  '23503', null, 'B can''t merge A''s products');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9b1', '00000000-0000-0000-0000-00000000d9a1')$$,
  '23503', null, 'B can''t merge its product into one of A''s');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9b1')$$,
  '23503', null, 'B can''t pull A''s product into its own');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9a03","role":"authenticated"}';
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9a1')$$,
  '42501', null, 'a viewer can''t merge');
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f9a01","role":"authenticated"}';
select throws_ok($$update product set merged_into_id = '00000000-0000-0000-0000-00000000d9a1'
  where id = '00000000-0000-0000-0000-00000000d9a2'$$, '42501', null, 'merged_into_id is set by the merge only');
select is((select count(*)::int from stock_lot where product_id = '00000000-0000-0000-0000-00000000d9a2'), 1, 'nothing moved yet');

-- ── Refusals ──────────────────────────────────────────────────────────────────
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a1', '00000000-0000-0000-0000-00000000d9a1')$$,
  'GDMRG', null, 'not into itself');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9a8')$$,
  'GDMRG', null, 'not into an archived product');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a6', '00000000-0000-0000-0000-00000000d9a7')$$,
  'GDMRG', null, 'not a product into its own sub-product');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a5', '00000000-0000-0000-0000-00000000d9a1')$$,
  'GDUNT', null, 'eggs (pcs) don''t convert to grams');
select is((select array[archived::text, coalesce(merged_into_id::text, '-')] from product where id = '00000000-0000-0000-0000-00000000d9a5'),
  array['false', '-'], '… and nothing changed');

-- ── Same unit: Freelan Mustard Seeds → Mustard seeds ──────────────────────────
insert into t_c values ('m1', rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9a1'));
select is((select v ->> 'mode' from t_c where k = 'm1'), 'repoint', 'same unit: re-pointed');
select is((select (v ->> 'movements')::int from t_c where k = 'm1'), 2, 'its purchase and use moved to Mustard seeds');
select is((select count(*)::int from stock_movement where product_id = '00000000-0000-0000-0000-00000000d9a2'), 0, 'no journal rows left on Freelan');
select is((select sum(qty_remaining) from stock_lot where product_id = '00000000-0000-0000-0000-00000000d9a1'), 450.0000::numeric,
  'Mustard seeds now has 200 + 250 g');
select ok(not exists (select 1 from stock_lot l
  where l.product_id = '00000000-0000-0000-0000-00000000d9a1'
    and l.qty_remaining <> (select sum(m.delta) from stock_movement m where m.lot_id = l.id)), 'every lot still = Σ its movements');
select is((select qty from v_product_stock where product_id = '00000000-0000-0000-0000-00000000d9a1'), 450.0000::numeric,
  'the stock view agrees');
select is((select count(*)::int from v_product_price where product_id = '00000000-0000-0000-0000-00000000d9a1'), 1,
  'the bill price came along');
select is((select product_id from product_alias where alias_norm = 'freelan mustard seeds 100g'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'the learned bill name points at Mustard seeds');
select is((select product_id from product_alias where alias_norm = 'freelan mustard seeds'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'and the old name was learned too');
select is((select product_id from product_barcode where barcode = '4790000000101'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'the barcode scans as Mustard seeds');
select is((select count(*)::int from shopping_list_item where id = '00000000-0000-0000-0000-00000000e9a1'), 0,
  'the duplicate open list item is gone (Mustard seeds is already on the list)');
select is((select product_id from shopping_list_item where id = '00000000-0000-0000-0000-00000000e9a3'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'the ticked item moved');
select is((select holds_product_id from location where id = '00000000-0000-0000-0000-00000000c9a1'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'the jar holds Mustard seeds');
select is((select count(*)::int from scale_reading where product_id = '00000000-0000-0000-0000-00000000d9a1'), 1, 'the jar''s readings moved');
select is((select product_id from label_tag where household_id = '00000000-0000-0000-0000-0000000f9aaa' and slot = 0),
  '00000000-0000-0000-0000-00000000d9a1'::uuid, 'its QR label opens Mustard seeds');
select is((select product_id from transaction_line where id = '00000000-0000-0000-0000-00000000b9b1'), '00000000-0000-0000-0000-00000000d9a1'::uuid,
  'the bill line points at Mustard seeds');
select is((select default_location_id from product where id = '00000000-0000-0000-0000-00000000d9a1'), '00000000-0000-0000-0000-00000000c9a0'::uuid,
  'the usual place was empty, so it took Freelan''s');
select is((select array[archived::text, merged_into_id::text] from product where id = '00000000-0000-0000-0000-00000000d9a2'),
  array['true', '00000000-0000-0000-0000-00000000d9a1'], 'Freelan is archived and says where it went');
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a2', '00000000-0000-0000-0000-00000000d9a3')$$,
  'GDMRG', null, 'a merged product can''t be merged again');
select lives_ok($$select rpc_consume(jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000f9aaa',
  'product_id', '00000000-0000-0000-0000-00000000d9a1', 'qty', 400))$$, 'the jar''s old stock can be used as Mustard seeds');

-- ── Other unit: Brown sugar 1kg pack (pack) → Brown sugar (g) ─────────────────
insert into t_c values ('m2', rpc_product_merge('00000000-0000-0000-0000-00000000d9a4', '00000000-0000-0000-0000-00000000d9a3'));
select ok((select v ->> 'mode' = 'convert' and (v ->> 'factor')::numeric = 1000 from t_c where k = 'm2'),
  'pack → g by the pack size');
select is((select sum(qty_remaining) from stock_lot where product_id = '00000000-0000-0000-0000-00000000d9a3'), 2000.0000::numeric,
  '2 packs became 2000 g');
select is((select unit_cost from stock_lot where product_id = '00000000-0000-0000-0000-00000000d9a3'), 0.4500::numeric,
  'Rs 450 a pack = Rs 0.45 a gram');
select is((select sum(qty_remaining) from stock_lot where product_id = '00000000-0000-0000-0000-00000000d9a4'), 0.0000::numeric,
  'the pack lot is empty (its history stays on the archived product)');
select is((select unit_id from product_barcode where barcode = '4790000000202'), pg_temp.u('pack'),
  'its barcode still means one pack');
select throws_ok(format('select rpc_undo(%L)', (select v ->> 'correlation_id' from t_c where k = 'm2')),
  'GDUND', null, 'a merge can''t be undone');

-- ── The journal stays append-only ─────────────────────────────────────────────
reset role;
select is((select private.to_stock_qty('00000000-0000-0000-0000-00000000d9a3', pg_temp.u('pack'), 1)), 1000.0000::numeric,
  'and Brown sugar learned the pack size');
select throws_ok($$update stock_movement set product_id = '00000000-0000-0000-0000-00000000d9a6'
  where product_id = '00000000-0000-0000-0000-00000000d9a1'$$, '42501', null, 'outside a merge nobody re-points the journal');
select throws_ok($$update stock_movement set delta = delta + 1
  where product_id = '00000000-0000-0000-0000-00000000d9a1'$$, '42501', null, 'and quantities never change');

-- ── anon ──────────────────────────────────────────────────────────────────────
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select rpc_product_merge('00000000-0000-0000-0000-00000000d9a3', '00000000-0000-0000-0000-00000000d9a1')$$,
  '42501', null, 'anon can''t merge');

select * from finish();
rollback;
