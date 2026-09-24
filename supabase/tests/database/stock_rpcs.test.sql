-- Stock RPCs: unit conversion, normalised cost, default due dates, FEFO across lots (opened first),
-- waste, not-enough-stock, open with split, transfers (whole / partial / into the freezer),
-- inventory up and down, extend due, undo of each, undo refused after later use, the invariant
-- qty_remaining = Σ delta, stock value, stock-unit lock, places with stock can't be deleted.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create function pg_temp.today() returns date language sql stable as
  $$ select (now() at time zone 'Asia/Colombo')::date $$;
-- Results of the RPC calls, by name.
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f3101', 'stk-owner-a@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f31aa', 'Stock A');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f31aa', '00000000-0000-0000-0000-0000000f3101', 'owner');
insert into location (id, household_id, name, climate) values
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-0000000f31aa', 'Pantry', 'ambient'),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-0000000f31aa', 'Freezer', 'freezer'),
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-0000000f31aa', 'Kitchen', 'ambient');
insert into product (id, household_id, name, stock_unit_id, purchase_unit_id, default_location_id,
                     due_type, default_due_days, due_days_after_open, due_days_frozen) values
  ('00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-0000000f31aa', 'Sugar', pg_temp.u('g'), pg_temp.u('pack'),
   '00000000-0000-0000-0000-00000000c301', 'best_before', 180, 30, null),
  ('00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-0000000f31aa', 'Chicken', pg_temp.u('g'), null,
   '00000000-0000-0000-0000-00000000c303', 'expiry', 2, null, 90),
  ('00000000-0000-0000-0000-00000000d303', '00000000-0000-0000-0000-0000000f31aa', 'Eggs', pg_temp.u('pcs'), pg_temp.u('pack'),
   null, 'none', null, null, null),
  ('00000000-0000-0000-0000-00000000d304', '00000000-0000-0000-0000-0000000f31aa', 'Nescafe', pg_temp.u('bottle'), null,
   null, 'none', null, null, null);
insert into product_unit_conversion (household_id, product_id, from_unit_id, to_unit_id, factor) values
  ('00000000-0000-0000-0000-0000000f31aa', '00000000-0000-0000-0000-00000000d301', pg_temp.u('pack'), pg_temp.u('kg'), 0.4),
  ('00000000-0000-0000-0000-0000000f31aa', '00000000-0000-0000-0000-00000000d303', pg_temp.u('pack'), pg_temp.u('pcs'), 10),
  ('00000000-0000-0000-0000-0000000f31aa', '00000000-0000-0000-0000-00000000d304', pg_temp.u('bottle'), pg_temp.u('g'), 50);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f3101","role":"authenticated"}';

-- ── Purchase: conversion, cost per stock unit, due date ─────────────────────
insert into t_c values ('buy1', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 2, 'unit_id', pg_temp.u('pack'), 'total_cost', 440, 'purchased_on', '2026-09-01')));
select is((select qty_initial || ' ' || qty_remaining || ' ' || unit_cost || ' ' || due_date || ' ' || location_id
             from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  '800.0000 800.0000 0.5500 2027-02-28 00000000-0000-0000-0000-00000000c301',
  '2 packs (1 pack = 0.4 kg) = 800 g at Rs 0.55/g, best before +180 days, in the product''s place');

insert into t_c values ('buy2', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 1, 'unit_id', pg_temp.u('kg'), 'total_cost', 300, 'due_date', '2026-10-15')));
select is((select qty_remaining || ' ' || unit_cost || ' ' || due_date || ' ' || purchased_on
             from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  '1000.0000 0.3000 2026-10-15 ' || pg_temp.today(), '1 kg = 1000 g; explicit due date; bought today');

insert into t_c values ('eggs', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d303',
  'qty', 2, 'unit_id', pg_temp.u('pack'), 'total_cost', 1100)));
select is((select qty_remaining || ' ' || unit_cost || ' ' || coalesce(due_date::text, 'none') || ' ' || coalesce(location_id::text, 'nowhere')
             from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'eggs')),
  '20.0000 55.0000 none nowhere', '2 packs of 10 eggs = 20 pcs at Rs 55; no due date; no default place');
select is((select reason || ' ' || delta from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'eggs')),
  'purchase 20.0000', 'a purchase is one +qty movement');

select throws_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 1, 'unit_id', pg_temp.u('pcs')))$$, 'GDUNT', null, 'pieces of sugar can''t be converted to grams');
select throws_ok($$select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 0))$$, '23514', null, 'quantity must be positive');
select is((select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d303',
  'qty', 5, 'unit_id', pg_temp.u('pcs'))) ->> 'qty'), '5.0000', 'the stock unit itself needs no conversion');
select is((select rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d304',
  'qty', 100, 'unit_id', pg_temp.u('g'))) ->> 'qty'), '2.0000',
  'counted in bottles of 50 g: 100 g = 2 bottles (conversion used backwards)');

-- ── FEFO consume across two lots, and its undo ──────────────────────────────
insert into t_c values ('use1', rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 1.2, 'unit_id', pg_temp.u('kg'))));
select is((select v ->> 'qty' || ' ' || (v ->> 'cost') || ' ' || (v ->> 'lots') from t_c where k = 'use1'),
  '1200.0000 410.00 2', '1.2 kg taken from 2 lots; cost 1000 × 0.30 + 200 × 0.55');
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  0.0000, 'FEFO: the lot due first (15 Oct) is emptied first');
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  600.0000, '… and the rest comes from the next lot');
select is((select status from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  'empty', 'an emptied lot is marked empty');

insert into t_c values ('undo1', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'use1')));
select is((select string_agg(qty_remaining::text, ',' order by due_date) from stock_lot
            where id in (select (v ->> 'lot_id')::uuid from t_c where k in ('buy1', 'buy2'))),
  '1000.0000,800.0000', 'undo puts both lots back');
select is((select count(*)::int from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'undo1') and reason = 'undo'),
  2, 'one undo row per reversed movement');
select throws_ok($$select rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'use1'))$$,
  'GDUND', null, 'an action can be undone only once');

-- ── Not enough stock / waste ────────────────────────────────────────────────
select throws_ok($$select rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 5000))$$, 'GDSTK', null, 'asking for more than there is is refused');
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  800.0000, '… and takes nothing');
insert into t_c values ('waste1', rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 50, 'lot_id', (select v ->> 'lot_id' from t_c where k = 'buy1'), 'reason', 'waste')));
select is((select reason || ' ' || delta || ' ' || unit_cost from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'waste1')),
  'waste -50.0000 0.5500', 'waste from a chosen lot is journalled with its cost');
select throws_ok($$select rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 1, 'reason', 'adjust'))$$, '23514', null, 'consume only takes consume or waste');

-- ── Open part of a lot: it splits off, opened, with the after-open due date ─
insert into t_c values ('open1', rpc_open(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buy1'), 'qty', 1, 'unit_id', pg_temp.u('pack'))));
select is((select qty_remaining || ' ' || (opened_at is not null) || ' ' || due_date || ' ' || (split_from_id::text = (select v ->> 'lot_id' from t_c where k = 'buy1'))
             from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'open1')),
  '400.0000 true ' || (pg_temp.today() + 30) || ' true', 'the opened pack is its own lot, due 30 days after opening');
select is((select qty_remaining || ' ' || (opened_at is null) from stock_lot
            where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  '350.0000 true', 'the rest stays unopened');

-- Opened first: the opened lot is due later than the 15 Oct lot, but is used first.
insert into t_c values ('use2', rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'qty', 100)));
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'open1')),
  300.0000, 'FEFO uses the opened lot before an earlier-due unopened one');
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  1000.0000, 'the unopened lot is untouched');
select throws_ok($$select rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'open1'))$$,
  'GDUND', null, 'the open can''t be undone after the opened lot was used');
insert into t_c values ('undo2', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'use2')));
insert into t_c values ('undo3', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'open1')));
select is((select qty_remaining || ' ' || (opened_at is null) from stock_lot
            where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  '750.0000 true', 'once the later use is undone, the open can be undone too');

-- Open a whole lot (by product: the first unopened lot in FEFO order), then undo restores its state.
insert into t_c values ('open2', rpc_open(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301')));
select is((select v ->> 'lot_id' from t_c where k = 'open2'), (select v ->> 'lot_id' from t_c where k = 'buy2'),
  'opening by product picks the unopened lot due first, whole');
select is((select (opened_at is not null) || ' ' || due_date from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  'true 2026-10-15', 'the due date stays when it is earlier than today + 30');
insert into t_c values ('undo4', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'open2')));
select is((select (opened_at is null) || ' ' || due_date from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  'true 2026-10-15', 'undo of a whole-lot open clears opened_at again');

-- ── Transfers ────────────────────────────────────────────────────────────────
insert into t_c values ('move1', rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'to_location_id', '00000000-0000-0000-0000-00000000c303',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buy2'))));
select is((select location_id::text || ' ' || qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy2')),
  '00000000-0000-0000-0000-00000000c303 1000.0000', 'a whole lot moves to the kitchen');
select is((select string_agg(reason || ' ' || delta, ',' order by seq) from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'move1')),
  'transfer_out -1000.0000,transfer_in 1000.0000', 'as a transfer_out / transfer_in pair');

insert into t_c values ('move2', rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'to_location_id', '00000000-0000-0000-0000-00000000c303',
  'product_id', '00000000-0000-0000-0000-00000000d301', 'from_location_id', '00000000-0000-0000-0000-00000000c301',
  'qty', 150)));
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  600.0000, 'a partial move takes 150 g from the pantry lot');
select is((select count(*)::int from stock_lot where split_from_id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')
             and location_id = '00000000-0000-0000-0000-00000000c303' and qty_remaining = 150 and unit_cost = 0.55),
  1, '… into a new kitchen lot with the same cost');
insert into t_c values ('undo5', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'move2')));
select is((select qty_remaining from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  750.0000, 'undo of the partial move returns the 150 g');
select throws_ok($$select rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'to_location_id', '00000000-0000-0000-0000-00000000c303',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buy2')))$$, 'GDSTK', null, 'moving a lot to where it already is does nothing');

-- Freezer: an expiry product frozen gets its frozen days; undo brings back place and date.
insert into t_c values ('chk', rpc_purchase(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d302',
  'qty', 1, 'unit_id', pg_temp.u('kg'), 'total_cost', 1500)));
select is((select due_date from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'chk')),
  pg_temp.today() + 2, 'fresh chicken expires in 2 days');
insert into t_c values ('frz', rpc_transfer(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'to_location_id', '00000000-0000-0000-0000-00000000c302',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'chk'))));
select is((select due_date || ' ' || location_id from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'chk')),
  (pg_temp.today() + 90) || ' 00000000-0000-0000-0000-00000000c302', 'frozen: due in 90 days, in the freezer');
select is((select value::text from v_product_stock where product_id = '00000000-0000-0000-0000-00000000d302'),
  '1500.00', 'stock value = 1000 g × Rs 1.50');
insert into t_c values ('undo6', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'frz')));
select is((select due_date || ' ' || location_id from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'chk')),
  (pg_temp.today() + 2) || ' 00000000-0000-0000-0000-00000000c303', 'undo: back in the kitchen, 2-day expiry again');
select is((select next_due from v_stock where product_id = '00000000-0000-0000-0000-00000000d302'
            and location_id = '00000000-0000-0000-0000-00000000c303'), pg_temp.today() + 2, 'v_stock shows it per place');

-- ── Inventory ────────────────────────────────────────────────────────────────
insert into t_c values ('inv1', rpc_inventory(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'location_id', '00000000-0000-0000-0000-00000000c303', 'qty', 1.05, 'unit_id', pg_temp.u('kg'))));
select is((select v ->> 'delta' from t_c where k = 'inv1'), '50.0000', 'counted 1.05 kg in the kitchen where 1 kg was: +50 g');
select is((select l.qty_remaining || ' ' || l.location_id from stock_lot l join stock_movement m on m.lot_id = l.id
            where m.correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'inv1')),
  '50.0000 00000000-0000-0000-0000-00000000c303', 'the surplus is a new lot in the kitchen');
select is((select l.unit_cost is not null from stock_lot l join stock_movement m on m.lot_id = l.id
            where m.correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'inv1')),
  true, '… valued at the last known cost');
insert into t_c values ('inv2', rpc_inventory(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'location_id', '00000000-0000-0000-0000-00000000c303', 'qty', 900)));
select is((select string_agg(reason || ' ' || delta, ',') from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'inv2')),
  'adjust -150.0000', 'counted 900 g where 1050 g were: −150 g as one adjust');
select is((select v ->> 'correlation_id' from t_c where k = 'inv2') is not null
          and (select rpc_inventory(jsonb_build_object(
            'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
            'location_id', '00000000-0000-0000-0000-00000000c303', 'qty', 900)) ->> 'delta') = '0',
  true, 'counting the same again changes nothing');

-- ── Extend a due date ────────────────────────────────────────────────────────
insert into t_c values ('due1', rpc_set_lot_due(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa',
  'lot_id', (select v ->> 'lot_id' from t_c where k = 'buy1'), 'due_date', '2027-03-30')));
select is((select due_date from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  '2027-03-30'::date, '"still fine — extend" moves the due date');
select is((select reason || ' ' || delta || ' ' || (meta #>> '{before,due_date}') from stock_movement
            where correlation_id = (select (v ->> 'correlation_id')::uuid from t_c where k = 'due1')),
  'edit 0.0000 2027-02-28', '… journalled as an edit with the old date');
insert into t_c values ('undo7', rpc_undo((select (v ->> 'correlation_id')::uuid from t_c where k = 'due1')));
select is((select due_date from stock_lot where id = (select (v ->> 'lot_id')::uuid from t_c where k = 'buy1')),
  '2027-02-28'::date, 'undo restores the old date');

-- ── Consume "all" at one place ───────────────────────────────────────────────
insert into t_c values ('all1', rpc_consume(jsonb_build_object(
  'household_id', '00000000-0000-0000-0000-0000000f31aa', 'product_id', '00000000-0000-0000-0000-00000000d301',
  'all', true, 'location_id', '00000000-0000-0000-0000-00000000c303')));
select is((select coalesce(sum(qty), 0) from v_stock where product_id = '00000000-0000-0000-0000-00000000d301'
            and location_id = '00000000-0000-0000-0000-00000000c303'), 0::numeric, '"use all" in the kitchen empties it there');
select is((select qty from v_stock where product_id = '00000000-0000-0000-0000-00000000d301'
            and location_id = '00000000-0000-0000-0000-00000000c301'), 750.0000, '… and leaves the pantry alone');

-- ── Invariants and guards ────────────────────────────────────────────────────
select ok((select bool_and(l.qty_remaining = coalesce(s.total, 0))
             from stock_lot l
             left join (select lot_id, sum(delta) total from stock_movement group by lot_id) s on s.lot_id = l.id
            where l.household_id = '00000000-0000-0000-0000-0000000f31aa'),
  'every lot''s quantity equals the sum of its movements');
select is((select v.qty_opened || ' ' || v.below_min from v_product_stock v where v.product_id = '00000000-0000-0000-0000-00000000d301'),
  '0 false', 'v_product_stock: nothing opened; no minimum set');

select throws_ok($$update product set stock_unit_id = pg_temp.u('kg') where id = '00000000-0000-0000-0000-00000000d301'$$,
  'GDUNL', null, 'the stock unit is fixed once there is stock history');
select throws_ok($$delete from location where id = '00000000-0000-0000-0000-00000000c301'$$,
  '23503', null, 'a place that still holds stock can''t be deleted');
select throws_ok($$delete from product where id = '00000000-0000-0000-0000-00000000d301'$$,
  '23503', null, 'a product with stock history can''t be deleted (archive it)');
select lives_ok($$delete from location where id = '00000000-0000-0000-0000-00000000c302'$$,
  'a place with no stock left (the chicken went back) can be deleted');
select is((select count(*)::int from stock_movement where location_id = '00000000-0000-0000-0000-00000000c302'), 0,
  '… and the journal simply forgets it');

select * from finish();
rollback;
